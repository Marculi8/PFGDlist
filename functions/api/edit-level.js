// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/edit-level

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';

const DIR_BY_LIST_TYPE = {
    classic: 'data',
    platformer: 'data/platformer',
    challenge: 'data/challenge',
    impossible: 'data/impossible',
    verifications: 'data/verifications',
};

export async function onRequestPost({ request, env }) {
    try {
        const {
            listType,
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
            category,
            notes,
            difficulty,
            rating,
            tags,
            dateAddedOverride,
            verifierEnjoyment,
        } = await request.json();

        const dir = DIR_BY_LIST_TYPE[listType];
        if (!dir) {
            return json({ error: `Unknown list type: ${listType}` }, 400);
        }
        const isImpossible = listType === 'impossible';
        const isVerifications = listType === 'verifications';
        if (
            !path || !name || !author ||
            (!isVerifications && !id) ||
            (!isImpossible && !isVerifications && (!verifier || !verification)) ||
            (isImpossible && !showcase)
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

        // 2. Confirm the caller is an admin.
        const profileRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?id=eq.${(await userRes.json()).id}&select=role`,
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
            'User-Agent': 'rgdl-edit-level',
        };

        // 3. Fetch the current file (need its sha + existing records, which we must preserve).
        const levelFilePath = `${dir}/${path}.json`;
        const fileRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (!fileRes.ok) {
            return json({ error: `Could not find level file "${levelFilePath}".` }, 404);
        }
        const fileData = await fileRes.json();
        const currentJson = JSON.parse(decodeURIComponent(escape(atob(fileData.content))));

        // 4. Merge the edited metadata, keeping records/status/percent untouched.
        // date_updated é atualizado aqui em edições normais (essa função só cobre
        // edições de verdade — records/victors passam por /api/edit-records,
        // então nunca batem nesse arquivo). Quando dateAddedOverride vem junto
        // (o "Mark as New again", usado como gambiarra pra fases antigas que
        // nunca tiveram date_added), a gente NÃO grava date_updated — assim,
        // quando o New expirar, não vira "Updated" sozinho.
        const dateAddedPatch = dateAddedOverride ? { date_added: dateAddedOverride } : {};
        const dateUpdatedPatch = dateAddedOverride ? {} : { date_updated: new Date().toISOString() };
        const updatedJson = isVerifications
            ? {
                  ...currentJson,
                  id: id ? Number(id) : null,
                  name,
                  author,
                  creators: Array.isArray(creators) && creators.length ? creators : [author],
                  category: category || currentJson.category || 'classic',
                  showcase: showcase || currentJson.showcase || '',
                  password: password || 'Copyable',
                  notes: notes ?? currentJson.notes ?? '',
                  tags: Array.isArray(tags) ? tags : (currentJson.tags || []),
                  ...dateUpdatedPatch,
                  ...dateAddedPatch,
              }
            : {
                  ...currentJson,
                  id: Number(id),
                  name,
                  author,
                  creators: Array.isArray(creators) && creators.length ? creators : [author],
                  verifier: verifier || currentJson.verifier || '',
                  verification: verification || currentJson.verification || '',
                  showcase: showcase || currentJson.showcase || '',
                  percentToQualify: Number(percentToQualify) || 100,
                  password: password || 'Copyable',
                  difficulty: difficulty || null,
                  rating: difficulty ? (Number(rating) || 1) : null,
                  records: currentJson.records || [],
                  verifier_enjoyment: (typeof verifierEnjoyment === 'number') ? verifierEnjoyment : (verifierEnjoyment === null ? null : currentJson.verifier_enjoyment ?? null),
                  tags: Array.isArray(tags) ? tags : (currentJson.tags || []),
                  ...dateUpdatedPatch,
                  ...dateAddedPatch,
              };

        const newContentB64 = btoa(
            unescape(encodeURIComponent(JSON.stringify(updatedJson, null, 4))),
        );

        const commitRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Edit level: ${name}`,
                    content: newContentB64,
                    sha: fileData.sha,
                    branch,
                }),
            },
        );
        if (!commitRes.ok) {
            const err = await commitRes.text();
            return json({ error: `Failed to save changes: ${err}` }, 502);
        }

        return json({ success: true });
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
