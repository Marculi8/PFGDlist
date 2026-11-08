// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/approve-level-suggestion
//
// Approves a player-submitted level suggestion: creates the level's .json file
// and inserts it into the ordered list, same as the admin "Add Level" flow,
// but reading the data from the level_suggestions row instead of a form.

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';

const LIST_CONFIG = {
    classic: { dir: 'data', listFile: 'data/_list.json' },
    platformer: { dir: 'data/platformer', listFile: 'data/platformer/_platformer_list.json' },
    challenge: { dir: 'data/challenge', listFile: 'data/challenge/_challenge_list.json' },
    impossible: { dir: 'data/impossible', listFile: 'data/impossible/_impossible_list.json' },
    verifications: { dir: 'data/verifications', listFile: 'data/verifications/_verifications_list.json' },
};

export async function onRequestPost({ request, env }) {
    try {
        const { suggestionId, position: overridePosition } = await request.json();
        if (!suggestionId) {
            return json({ error: 'Missing suggestionId.' }, 400);
        }

        // 1. Identify the caller from their Supabase access token.
        const authHeader = request.headers.get('Authorization') || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (!token) {
            return json({ error: 'Not authenticated.' }, 401);
        }
        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
        });
        if (!userRes.ok) {
            return json({ error: 'Invalid session.' }, 401);
        }
        const user = await userRes.json();

        const svcHeaders = {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        };

        // 2. Confirm the caller is mod/admin.
        const profileRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`,
            { headers: svcHeaders },
        );
        const profiles = await profileRes.json();
        const role = profiles?.[0]?.role;
        if (role !== 'mod' && role !== 'admin') {
            return json({ error: 'You do not have permission to do this.' }, 403);
        }

        // 3. Load the suggestion itself.
        const sugRes = await fetch(
            `${SUPABASE_URL}/rest/v1/level_suggestions?id=eq.${suggestionId}&select=*`,
            { headers: svcHeaders },
        );
        const suggestions = await sugRes.json();
        const suggestion = suggestions?.[0];
        if (!suggestion) {
            return json({ error: 'Suggestion not found.' }, 404);
        }
        if (suggestion.status !== 'pending') {
            return json({ error: 'This suggestion was already reviewed.' }, 409);
        }

        const config = LIST_CONFIG[suggestion.list_type];
        if (!config) {
            return json({ error: `Unknown list_type: ${suggestion.list_type}` }, 400);
        }

        const owner = env.GITHUB_OWNER;
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || 'main';
        const ghHeaders = {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'rgdl-approve-level-suggestion',
        };

        // 4. Make sure a level with this path doesn't already exist.
        const levelFilePath = `${config.dir}/${suggestion.path}.json`;
        const existingRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (existingRes.ok) {
            return json({ error: `A level file already exists at "${levelFilePath}".` }, 409);
        }

        // 5. Create the new level's .json file.
        const isVerifications = suggestion.list_type === 'verifications';
        const levelJson = isVerifications
            ? {
                  id: suggestion.level_id ? Number(suggestion.level_id) : null,
                  name: suggestion.name,
                  author: suggestion.author,
                  creators: suggestion.creators?.length ? suggestion.creators : [suggestion.author],
                  status: suggestion.verification_status || 'open_verification',
                  category: suggestion.category || 'classic',
                  verifier: suggestion.verification_status === 'set_verifier' ? (suggestion.verifier || '') : '',
                  percent: 0,
                  showcase: suggestion.showcase_link || '',
                  password: suggestion.password || 'Copyable',
                  notes: suggestion.notes || '',
                  verified_date: null,
              }
            : {
                  id: Number(suggestion.level_id),
                  name: suggestion.name,
                  author: suggestion.author,
                  creators: suggestion.creators?.length ? suggestion.creators : [suggestion.author],
                  verifier: suggestion.verifier || '',
                  verification: suggestion.verification_link || '',
                  showcase: suggestion.showcase_link || '',
                  percentToQualify: suggestion.percent_to_qualify || 100,
                  password: suggestion.password || 'Copyable',
                  records: [],
              };
        const levelContentB64 = btoa(
            unescape(encodeURIComponent(JSON.stringify(levelJson, null, 4))),
        );

        const createRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Add level: ${suggestion.name} (suggested)`,
                    content: levelContentB64,
                    branch,
                }),
            },
        );
        if (!createRes.ok) {
            const err = await createRes.text();
            return json({ error: `Failed to create level file: ${err}` }, 502);
        }

        // 6. Insert the new path into the ordered list file.
        const listRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${config.listFile}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (!listRes.ok) {
            return json(
                { error: `Level file was created, but could not read "${config.listFile}" to insert it into the list. Add it manually.` },
                502,
            );
        }
        const listData = await listRes.json();
        const list = JSON.parse(decodeURIComponent(escape(atob(listData.content))));

        const position = overridePosition || suggestion.suggested_position || list.length + 1;
        const insertIndex = Math.min(Math.max(Number(position) - 1, 0), list.length);
        list.splice(insertIndex, 0, suggestion.path);

        const newListB64 = btoa(
            unescape(encodeURIComponent(JSON.stringify(list, null, 4))),
        );

        const updateListRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${config.listFile}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Insert "${suggestion.path}" into ${suggestion.list_type} list at position ${insertIndex + 1}`,
                    content: newListB64,
                    sha: listData.sha,
                    branch,
                }),
            },
        );
        if (!updateListRes.ok) {
            const err = await updateListRes.text();
            return json(
                { error: `Level file was created, but failed to update the list order: ${err}. Add "${suggestion.path}" to ${config.listFile} manually.` },
                502,
            );
        }

        // 7. Mark the suggestion as approved.
        await fetch(`${SUPABASE_URL}/rest/v1/level_suggestions?id=eq.${suggestionId}`, {
            method: 'PATCH',
            headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
                status: 'approved',
                reviewer_id: user.id,
                updated_at: new Date().toISOString(),
            }),
        });

        // 8. Notify the player who suggested it.
        await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
            method: 'POST',
            headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
                user_id: suggestion.user_id,
                type: 'level_suggestion_approved',
                message: isVerifications
                    ? `Your verification suggestion "${suggestion.name}" was approved and added to the Verifications list!`
                    : `Your level suggestion "${suggestion.name}" was approved and added to the list!`,
                link: isVerifications ? '/verifications' : '/',
            }),
        });

        return json({ success: true, position: insertIndex + 1 });
    } catch (err) {
        return json({ error: err.message || 'Unexpected error.' }, 500);
    }
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
