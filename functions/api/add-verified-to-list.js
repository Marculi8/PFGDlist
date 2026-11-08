// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/add-verified-to-list
//
// Admin pega uma fase já Verified (de Verifications) e cria ela de verdade
// na lista principal (Classic/Platformer/Challenge), na posição escolhida.
// Marca a fase de Verifications como "já adicionada" depois.

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';

const LIST_CONFIG = {
    classic: { dir: 'data', listFile: 'data/_list.json' },
    platformer: { dir: 'data/platformer', listFile: 'data/platformer/_platformer_list.json' },
    challenge: { dir: 'data/challenge', listFile: 'data/challenge/_challenge_list.json' },
};

export async function onRequestPost({ request, env }) {
    try {
        const body = await request.json();
        const {
            verificationPath, // path da fase em data/verifications/
            targetList, // 'classic' | 'platformer' | 'challenge'
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
        } = body;

        const config = LIST_CONFIG[targetList];
        if (!config) {
            return json({ error: `Unknown target list: ${targetList}` }, 400);
        }
        if (!verificationPath || !path || !name || !author || !id || !verifier || !verification) {
            return json({ error: 'Missing required fields.' }, 400);
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
            'User-Agent': 'rgdl-add-verified-to-list',
        };

        // 3. Load + update the target list's _list.json (insert the new path).
        const listFileRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${config.listFile}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (!listFileRes.ok) {
            return json({ error: `Could not load ${config.listFile}.` }, 502);
        }
        const listFileData = await listFileRes.json();
        const list = JSON.parse(decodeURIComponent(escape(atob(listFileData.content))));

        if (list.includes(path)) {
            return json({ error: `A level with path "${path}" already exists on that list.` }, 409);
        }

        const insertIndex = Math.min(Math.max((Number(position) || 1) - 1, 0), list.length);
        const newList = [...list];
        newList.splice(insertIndex, 0, path);

        const newListContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(newList, null, 4))));
        const listUpdateRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${config.listFile}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Promote ${name} from Verifications to ${targetList}`,
                    content: newListContentB64,
                    sha: listFileData.sha,
                    branch,
                }),
            },
        );
        if (!listUpdateRes.ok) {
            const err = await listUpdateRes.text();
            return json({ error: `Failed to update the list: ${err}` }, 502);
        }

        // 4. Create the new level's .json file.
        const levelJson = {
            id: Number(id),
            name,
            author,
            creators: Array.isArray(creators) && creators.length ? creators : [author],
            verifier,
            verification,
            showcase: showcase || '',
            percentToQualify: Number(percentToQualify) || 100,
            password: password || 'Copyable',
            records: [],
        };
        const levelContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(levelJson, null, 4))));
        const createRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${config.dir}/${path}.json`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Add level: ${name} (from Verifications)`,
                    content: levelContentB64,
                    branch,
                }),
            },
        );
        if (!createRes.ok) {
            const err = await createRes.text();
            return json({ error: `List updated, but failed to create the level file: ${err}` }, 502);
        }

        // 5. Mark the Verifications level as already promoted, and notify the verifier.
        const verFilePath = `data/verifications/${verificationPath}.json`;
        const verFileRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${verFilePath}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (verFileRes.ok) {
            const verFileData = await verFileRes.json();
            const verLevel = JSON.parse(decodeURIComponent(escape(atob(verFileData.content))));
            const updatedVerLevel = { ...verLevel, addedToList: true, addedToListAt: new Date().toISOString(), listAddRequest: null };
            const newVerContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(updatedVerLevel, null, 4))));
            await fetch(
                `https://api.github.com/repos/${owner}/${repo}/contents/${verFilePath}`,
                {
                    method: 'PUT',
                    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: `Verifications: ${name} added to ${targetList}`,
                        content: newVerContentB64,
                        sha: verFileData.sha,
                        branch,
                    }),
                },
            );

            const verifierProfileRes = await fetch(
                `${SUPABASE_URL}/rest/v1/profiles?or=(list_name.ilike.${encodeURIComponent(verLevel.verifier || '')},username.ilike.${encodeURIComponent(verLevel.verifier || '')})&select=id`,
                { headers: svcHeaders },
            );
            const verifierProfiles = await verifierProfileRes.json();
            if (verifierProfiles && verifierProfiles.length > 0) {
                await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
                    method: 'POST',
                    headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                    body: JSON.stringify({
                        user_id: verifierProfiles[0].id,
                        type: 'verification_added_to_list',
                        message: `"${name}" was added to the ${targetList} list!`,
                        link: `/player/${encodeURIComponent(verLevel.verifier || '')}`,
                    }),
                }).catch(() => {});
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
