// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/move-level
//
// Move uma fase de uma lista pra outra (ex: Classic -> Challenge).
// Remove do arquivo/lista de origem, cria no arquivo/lista de destino na
// posição escolhida. Como as 4 categorias (Classic/Platformer/Challenge/
// Impossible) compartilham o mesmo formato de arquivo, o conteúdo é
// preservado como está — só muda de pasta e entra na lista nova.

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';

const LIST_CONFIG = {
    classic: { dir: 'data', listFile: 'data/_list.json' },
    platformer: { dir: 'data/platformer', listFile: 'data/platformer/_platformer_list.json' },
    challenge: { dir: 'data/challenge', listFile: 'data/challenge/_challenge_list.json' },
    impossible: { dir: 'data/impossible', listFile: 'data/impossible/_impossible_list.json' },
};

export async function onRequestPost({ request, env }) {
    try {
        const { fromList, toList, path, position } = await request.json();

        const fromConfig = LIST_CONFIG[fromList];
        const toConfig = LIST_CONFIG[toList];
        if (!fromConfig || !toConfig) {
            return json({ error: 'Unknown source or target list.' }, 400);
        }
        if (!path) {
            return json({ error: 'Missing path.' }, 400);
        }
        if (fromList === toList) {
            return json({ error: 'Source and target list are the same — use Reorder instead.' }, 400);
        }

        // 1. Identify the caller.
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

        // 2. Confirm the caller is admin.
        const profileRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`,
            { headers: svcHeaders },
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
            'User-Agent': 'rgdl-move-level',
        };

        // 3. Load the level's file from the source list.
        const fromFilePath = `${fromConfig.dir}/${path}.json`;
        const fileRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${fromFilePath}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (!fileRes.ok) {
            return json({ error: `Level "${path}" not found in ${fromList}.` }, 404);
        }
        const fileData = await fileRes.json();
        const levelJson = JSON.parse(decodeURIComponent(escape(atob(fileData.content))));

        // 4. Make sure it doesn't already exist on the target list.
        const toFilePath = `${toConfig.dir}/${path}.json`;
        const existsRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${toFilePath}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (existsRes.ok) {
            return json({ error: `A level with path "${path}" already exists on ${toList}.` }, 409);
        }

        // 5. Remove from the source list's _list.json.
        const fromListRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${fromConfig.listFile}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (!fromListRes.ok) {
            return json({ error: `Could not read "${fromConfig.listFile}".` }, 502);
        }
        const fromListData = await fromListRes.json();
        const fromListArr = JSON.parse(decodeURIComponent(escape(atob(fromListData.content))));
        const idx = fromListArr.indexOf(path);
        if (idx === -1) {
            return json({ error: `"${path}" was not found in the ${fromList} list.` }, 404);
        }
        fromListArr.splice(idx, 1);
        const newFromListB64 = btoa(unescape(encodeURIComponent(JSON.stringify(fromListArr, null, 4))));
        const updateFromListRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${fromConfig.listFile}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Move "${path}" out of ${fromList} (-> ${toList})`,
                    content: newFromListB64,
                    sha: fromListData.sha,
                    branch,
                }),
            },
        );
        if (!updateFromListRes.ok) {
            const err = await updateFromListRes.text();
            return json({ error: `Failed to update the ${fromList} list: ${err}` }, 502);
        }

        // 6. Insert into the target list's _list.json at the chosen position.
        const toListRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${toConfig.listFile}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (!toListRes.ok) {
            return json({ error: `Could not read "${toConfig.listFile}".` }, 502);
        }
        const toListData = await toListRes.json();
        const toListArr = JSON.parse(decodeURIComponent(escape(atob(toListData.content))));
        const insertIndex = Math.min(Math.max((Number(position) || 1) - 1, 0), toListArr.length);
        toListArr.splice(insertIndex, 0, path);
        const newToListB64 = btoa(unescape(encodeURIComponent(JSON.stringify(toListArr, null, 4))));
        const updateToListRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${toConfig.listFile}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Move "${path}" into ${toList} at #${insertIndex + 1}`,
                    content: newToListB64,
                    sha: toListData.sha,
                    branch,
                }),
            },
        );
        if (!updateToListRes.ok) {
            const err = await updateToListRes.text();
            return json({ error: `Removed from ${fromList}, but failed to update the ${toList} list: ${err}` }, 502);
        }

        // 7. Create the level's file in the target dir (same content).
        const newFileContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(levelJson, null, 4))));
        const createRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${toFilePath}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Move level file: ${path} (${fromList} -> ${toList})`,
                    content: newFileContentB64,
                    branch,
                }),
            },
        );
        if (!createRes.ok) {
            const err = await createRes.text();
            return json({ error: `Lists updated, but failed to create the file on ${toList}: ${err}` }, 502);
        }

        // 8. Delete the old file from the source dir.
        const deleteRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${fromFilePath}`,
            {
                method: 'DELETE',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Delete old level file after move: ${path}`,
                    sha: fileData.sha,
                    branch,
                }),
            },
        );
        if (!deleteRes.ok) {
            return json({
                success: true,
                warning: `Moved to ${toList}, but failed to delete the old file at "${fromFilePath}". Delete it manually to avoid a duplicate.`,
            });
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
