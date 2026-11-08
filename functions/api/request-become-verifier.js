// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/request-become-verifier
//
// Jogador pede pra virar o Set Verifier de uma fase que hoje é Open
// Verification, com uma razão. Fica 'pending' até um mod/admin aprovar.

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';

export async function onRequestPost({ request, env }) {
    try {
        const { levelPath, reason } = await request.json();
        if (!levelPath || !reason || !reason.trim()) {
            return json({ error: 'Missing level or reason.' }, 400);
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

        // 2. Load the caller's profile.
        const profileRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=list_name,username`,
            { headers: svcHeaders },
        );
        const profiles = await profileRes.json();
        const displayName = profiles?.[0]?.list_name || profiles?.[0]?.username;
        if (!displayName) {
            return json({ error: 'You need to claim your profile / set a list name first.' }, 400);
        }

        // 3. Check the level is actually Open Verification right now.
        const owner = env.GITHUB_OWNER;
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || 'main';
        const ghHeaders = {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'rgdl-request-become-verifier',
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
        if (level.status !== 'open_verification') {
            return json({ error: 'This level is not Open Verification right now.' }, 409);
        }

        // 4. Don't allow duplicate pending requests from the same user for the same level.
        const dupRes = await fetch(
            `${SUPABASE_URL}/rest/v1/verifier_requests?level_path=eq.${encodeURIComponent(levelPath)}&user_id=eq.${user.id}&request_type=eq.become_verifier&status=eq.pending&select=id`,
            { headers: svcHeaders },
        );
        const dup = await dupRes.json();
        if (dup && dup.length > 0) {
            return json({ error: 'You already have a pending request for this level.' }, 409);
        }

        // 5. Insert the request.
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/verifier_requests`, {
            method: 'POST',
            headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
                level_path: levelPath,
                request_type: 'become_verifier',
                user_id: user.id,
                username: displayName,
                reason: reason.trim(),
            }),
        });
        if (!insertRes.ok) {
            const err = await insertRes.text();
            return json({ error: `Failed to send request: ${err}` }, 502);
        }

        // 6. Notify staff.
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
                        type: 'new_verifier_request',
                        message: `${displayName} wants to become the Set Verifier for "${level.name}".`,
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
