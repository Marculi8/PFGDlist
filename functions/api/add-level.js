// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/add-level

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
        const body = await request.json();
        const {
            listType,
            position,
            path,
            id,
            name,
            author,
            creators,
            verifier,
            verification,
            showcase,
            percentToQualify,
            password,
            status,
            category,
            difficulty,
            rating,
            verifierEnjoyment,
        } = body;

        const config = LIST_CONFIG[listType];
        if (!config) {
            return json({ error: `Unknown list type: ${listType}` }, 400);
        }
        const isImpossible = listType === 'impossible';
        const isVerifications = listType === 'verifications';
        const needsId = !isVerifications || status === 'open_verification';
        if (
            !path || !name || !author || (needsId && !id) ||
            (!isImpossible && !isVerifications && (!verifier || !verification)) ||
            (isImpossible && !showcase) ||
            (isVerifications && status === 'set_verifier' && !verifier)
        ) {
            return json({ error: 'Missing required fields.' }, 400);
        }

        // 1. Identify the caller from their Supabase access token.
        const authHeader = request.headers.get('Authorization') || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (!token) {
            return json({ error: 'Not authenticated.' }, 401);
        }

        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${token}`,
            },
        });
        if (!userRes.ok) {
            return json({ error: 'Invalid session.' }, 401);
        }
        const user = await userRes.json();

        // 2. Confirm the caller is an admin (service role bypasses RLS —
        //    safe here because we already verified their identity above).
        const profileRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`,
            {
                headers: {
                    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                },
            },
        );
        const profiles = await profileRes.json();
        const role = profiles?.[0]?.role;
        if (role !== 'admin') {
            return json({ error: 'You do not have permission to do this.' }, 403);
        }

        const owner = env.GITHUB_OWNER;
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || 'main';
        const ghHeaders = {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'rgdl-add-level',
        };

        // 3. Make sure a level with this path doesn't already exist.
        const levelFilePath = `${config.dir}/${path}.json`;
        const existingRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (existingRes.ok) {
            return json({ error: `A level file already exists at "${levelFilePath}".` }, 409);
        }

        // 4. Create the new level's .json file.
        const dateAdded = new Date().toISOString();
        const levelJson = isVerifications
            ? {
                  id: needsId ? Number(id) : null,
                  name,
                  author,
                  creators: Array.isArray(creators) ? creators : [author],
                  status: status || 'open_verification',
                  category: category || 'classic',
                  verifier: status === 'set_verifier' ? (verifier || '') : '',
                  percent: 0,
                  showcase: showcase || '',
                  password: password || 'Copyable',
                  notes: '',
                  verified_date: null,
                  date_added: dateAdded,
                  tags: [],
              }
            : {
                  id: Number(id),
                  name,
                  author,
                  creators: Array.isArray(creators) ? creators : [author],
                  verifier: verifier || '',
                  verification: verification || '',
                  showcase: showcase || '',
                  percentToQualify: Number(percentToQualify) || 100,
                  password: password || 'Copyable',
                  difficulty: difficulty || null,
                  rating: difficulty ? (Number(rating) || 1) : null,
                  records: [],
                  date_added: dateAdded,
                  verifier_enjoyment: (typeof verifierEnjoyment === 'number') ? verifierEnjoyment : null,
                  tags: [],
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
                    message: `Add level: ${name}`,
                    content: levelContentB64,
                    branch,
                }),
            },
        );
        if (!createRes.ok) {
            const err = await createRes.text();
            return json({ error: `Failed to create level file: ${err}` }, 502);
        }

        // 5. Insert the new path into the ordered list file.
        const listRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${config.listFile}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (!listRes.ok) {
            return json(
                {
                    error: `Level file was created, but could not read "${config.listFile}" to insert it into the list. Add it manually.`,
                },
                502,
            );
        }
        const listData = await listRes.json();
        const list = JSON.parse(decodeURIComponent(escape(atob(listData.content))));

        // Clamp position into a valid 1-based range, then insert.
        // Verifications não tem ranking — sempre entra no final.
        const insertIndex = isVerifications
            ? list.length
            : Math.min(Math.max((Number(position) || 1) - 1, 0), list.length);
        list.splice(insertIndex, 0, path);

        const newListB64 = btoa(
            unescape(encodeURIComponent(JSON.stringify(list, null, 4))),
        );

        const updateListRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${config.listFile}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Insert "${path}" into ${listType} list at position ${insertIndex + 1}`,
                    content: newListB64,
                    sha: listData.sha,
                    branch,
                }),
            },
        );
        if (!updateListRes.ok) {
            const err = await updateListRes.text();
            return json(
                {
                    error: `Level file was created, but failed to update the list order: ${err}. Add "${path}" to ${config.listFile} manually.`,
                },
                502,
            );
        }

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
