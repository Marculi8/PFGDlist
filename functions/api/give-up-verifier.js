// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/give-up-verifier
//
// O Set Verifier atual desiste da fase. Aplica na hora (não precisa de
// aprovação — é o próprio jogador abrindo mão do que já era dele), mas
// exige uma razão e fica registrado pra auditoria.

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

        // 3. Load the level and confirm the caller is really its verifier.
        const owner = env.GITHUB_OWNER;
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || 'main';
        const ghHeaders = {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'rgdl-give-up-verifier',
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

        if (level.status !== 'set_verifier') {
            return json({ error: 'This level is not Set Verifier right now.' }, 409);
        }
        if ((level.verifier || '').toLowerCase() !== displayName.toLowerCase()) {
            return json({ error: 'You are not the assigned verifier for this level.' }, 403);
        }

        // 4. Apply: level becomes Open Verification again.
        const updatedLevel = { ...level, status: 'open_verification', verifier: '' };
        const newContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(updatedLevel, null, 4))));
        const updateRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Verifications: ${displayName} gave up verifying ${level.name} — now Open Verification`,
                    content: newContentB64,
                    sha: levelData.sha,
                    branch,
                }),
            },
        );
        if (!updateRes.ok) {
            const err = await updateRes.text();
            return json({ error: `Failed to update the level file: ${err}` }, 502);
        }

        // 5. Log it for audit (already applied, so it goes straight in as 'approved').
        await fetch(`${SUPABASE_URL}/rest/v1/verifier_requests`, {
            method: 'POST',
            headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
                level_path: levelPath,
                request_type: 'give_up',
                user_id: user.id,
                username: displayName,
                reason: reason.trim(),
                status: 'approved',
                reviewer_id: user.id,
                reviewed_at: new Date().toISOString(),
            }),
        });

        // 6. Notify staff, just for awareness.
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
                        type: 'verifier_gave_up',
                        message: `${displayName} gave up verifying "${level.name}". Reason: ${reason.trim()}`,
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
