// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/reorder-level

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';

const LIST_FILE_BY_TYPE = {
    classic: 'data/_list.json',
    platformer: 'data/platformer/_platformer_list.json',
    challenge: 'data/challenge/_challenge_list.json',
    impossible: 'data/impossible/_impossible_list.json',
};

export async function onRequestPost({ request, env }) {
    try {
        const { listType, path, position } = await request.json();

        const listFile = LIST_FILE_BY_TYPE[listType];
        if (!listFile) {
            return json({ error: `Unknown list type: ${listType}` }, 400);
        }
        if (!path || !position) {
            return json({ error: 'Missing path or position.' }, 400);
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
            'User-Agent': 'rgdl-reorder-level',
        };

        // 3. Fetch the current list, move the path to its new position.
        const listRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${listFile}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (!listRes.ok) {
            return json({ error: `Could not read "${listFile}".` }, 502);
        }
        const listData = await listRes.json();
        const list = JSON.parse(decodeURIComponent(escape(atob(listData.content))));

        const currentIndex = list.indexOf(path);
        if (currentIndex === -1) {
            return json({ error: `"${path}" was not found in the list.` }, 404);
        }

        list.splice(currentIndex, 1);
        const newIndex = Math.min(Math.max(Number(position) - 1, 0), list.length);
        list.splice(newIndex, 0, path);

        if (newIndex === currentIndex) {
            return json({ success: true, position: newIndex + 1, unchanged: true });
        }

        const newListB64 = btoa(
            unescape(encodeURIComponent(JSON.stringify(list, null, 4))),
        );

        const updateRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${listFile}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Move "${path}" to position ${newIndex + 1} in ${listType} list`,
                    content: newListB64,
                    sha: listData.sha,
                    branch,
                }),
            },
        );
        if (!updateRes.ok) {
            const err = await updateRes.text();
            return json({ error: `Failed to update the list: ${err}` }, 502);
        }

        return json({ success: true, position: newIndex + 1 });
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
