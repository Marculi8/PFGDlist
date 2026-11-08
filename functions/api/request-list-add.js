// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/request-list-add
//
// O verifier de uma fase já Verified pede pra ela ser adicionada na lista
// principal, sugerindo uma posição (o admin pode mudar na hora de aplicar).

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';

export async function onRequestPost({ request, env }) {
    try {
        const { levelPath, position } = await request.json();
        const positionNum = Number(position);
        if (!levelPath || !positionNum || positionNum < 1) {
            return json({ error: 'Missing level or invalid position.' }, 400);
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

        const profileRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=list_name,username`,
            { headers: svcHeaders },
        );
        const profiles = await profileRes.json();
        const displayName = profiles?.[0]?.list_name || profiles?.[0]?.username;
        if (!displayName) {
            return json({ error: 'You need to claim your profile / set a list name first.' }, 400);
        }

        // 2. Load the level, confirm it's Verified and the caller is its verifier.
        const owner = env.GITHUB_OWNER;
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || 'main';
        const ghHeaders = {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'rgdl-request-list-add',
        };
        const levelFilePath = `data/verifications/${levelPath}.json`;
        const levelRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (!levelRes.ok) {
            return json({ error: `Level "${levelPath}" not found.` }, 404);
        }
        const levelData = await levelRes.json();
        const level = JSON.parse(decodeURIComponent(escape(atob(levelData.content))));

        if (level.status !== 'verified') {
            return json({ error: 'This level is not Verified yet.' }, 409);
        }
        if ((level.verifier || '').toLowerCase() !== displayName.toLowerCase()) {
            return json({ error: 'You are not the verifier of this level.' }, 403);
        }
        if (level.addedToList) {
            return json({ error: 'This level was already added to the list.' }, 409);
        }

        // 3. Patch the level with the request (admin's form reads this to prefill position).
        const updatedLevel = {
            ...level,
            listAddRequest: {
                position: positionNum,
                requestedBy: displayName,
                requestedAt: new Date().toISOString(),
            },
        };
        const newContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(updatedLevel, null, 4))));
        const updateRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Verifications: ${displayName} requested ${level.name} be added at #${positionNum}`,
                    content: newContentB64,
                    sha: levelData.sha,
                    branch,
                }),
            },
        );
        if (!updateRes.ok) {
            const err = await updateRes.text();
            return json({ error: `Failed to save the request: ${err}` }, 502);
        }

        // 4. Notify staff.
        const staffRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?role=in.(mod,admin)&select=id`,
            { headers: svcHeaders },
        );
        const staff = await staffRes.json();
        if (staff && staff.length > 0) {
            await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
                method: 'POST',
                headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify(
                    staff.map((s) => ({
                        user_id: s.id,
                        type: 'list_add_requested',
                        message: `${displayName} wants "${level.name}" added to the ${level.category || 'classic'} list at #${positionNum}.`,
                        link: '/verifications',
                    })),
                ),
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
