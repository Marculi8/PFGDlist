// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/remove-level

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
        const { listType, path } = await request.json();

        const config = LIST_CONFIG[listType];
        if (!config) {
            return json({ error: `Unknown list type: ${listType}` }, 400);
        }
        if (!path) {
            return json({ error: 'Missing path.' }, 400);
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
            'User-Agent': 'rgdl-remove-level',
        };

        // 3. Remove the path from the ordered list file.
        const listRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${config.listFile}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (!listRes.ok) {
            return json({ error: `Could not read "${config.listFile}".` }, 502);
        }
        const listData = await listRes.json();
        const list = JSON.parse(decodeURIComponent(escape(atob(listData.content))));

        const index = list.indexOf(path);
        if (index === -1) {
            return json({ error: `"${path}" was not found in the list.` }, 404);
        }
        list.splice(index, 1);

        const newListB64 = btoa(
            unescape(encodeURIComponent(JSON.stringify(list, null, 4))),
        );

        const updateListRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${config.listFile}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Remove "${path}" from ${listType} list`,
                    content: newListB64,
                    sha: listData.sha,
                    branch,
                }),
            },
        );
        if (!updateListRes.ok) {
            const err = await updateListRes.text();
            return json({ error: `Failed to update the list: ${err}` }, 502);
        }

        // 4. Delete the level's .json file.
        const levelFilePath = `${config.dir}/${path}.json`;
        const fileRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (fileRes.ok) {
            const fileData = await fileRes.json();
            const deleteRes = await fetch(
                `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}`,
                {
                    method: 'DELETE',
                    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: `Delete level file: ${path}`,
                        sha: fileData.sha,
                        branch,
                    }),
                },
            );
            if (!deleteRes.ok) {
                return json({
                    success: true,
                    warning: `Removed from the list, but failed to delete the file "${levelFilePath}". Delete it manually.`,
                });
            }
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
