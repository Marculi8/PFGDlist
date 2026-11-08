// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/edit-records
//
// Lets an admin directly edit a level's records (completions), without going
// through the Submissions approval flow. The client sends the FULL desired
// records array; this just overwrites it and commits.

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';

const DIR_BY_LIST_TYPE = {
    classic: 'data',
    platformer: 'data/platformer',
    challenge: 'data/challenge',
    impossible: 'data/impossible',
};

export async function onRequestPost({ request, env }) {
    try {
        const { listType, path, records } = await request.json();

        const dir = DIR_BY_LIST_TYPE[listType];
        if (!dir) {
            return json({ error: `Unknown list type: ${listType}` }, 400);
        }
        if (!path || !Array.isArray(records)) {
            return json({ error: 'Missing path or records.' }, 400);
        }

        // Validate each record has the required shape before writing anything.
        for (const r of records) {
            if (!r.user || typeof r.user !== 'string') {
                return json({ error: 'Every record needs a user name.' }, 400);
            }
            if (typeof r.percent !== 'number' || r.percent < 1 || r.percent > 100) {
                return json({ error: `Invalid percent for "${r.user}": must be 1-100.` }, 400);
            }
            if (!r.link || typeof r.link !== 'string') {
                return json({ error: `Missing link for "${r.user}".` }, 400);
            }
            if (typeof r.hz !== 'number' || r.hz < 1) {
                return json({ error: `Invalid hz for "${r.user}".` }, 400);
            }
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

        // 2. Confirm the caller is an admin.
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
        if (profiles?.[0]?.role !== 'admin') {
            return json({ error: 'You do not have permission to do this.' }, 403);
        }

        const owner = env.GITHUB_OWNER;
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || 'main';
        const ghHeaders = {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'rgdl-edit-records',
        };

        // 3. Fetch the current file (need sha + the rest of its content).
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

        // 4. Swap in the new records, keep everything else untouched.
        const updatedJson = { ...currentJson, records };

        const newContentB64 = btoa(
            unescape(encodeURIComponent(JSON.stringify(updatedJson, null, 4))),
        );

        const commitRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Edit records for ${currentJson.name || path}`,
                    content: newContentB64,
                    sha: fileData.sha,
                    branch,
                }),
            },
        );
        if (!commitRes.ok) {
            const err = await commitRes.text();
            return json({ error: `Failed to save records: ${err}` }, 502);
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
