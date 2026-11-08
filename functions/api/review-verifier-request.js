// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/review-verifier-request
//
// Mod/admin aprova ou rejeita um pedido pendente de "virar Set Verifier"
// (request_type = 'become_verifier'). Aprovar muda a fase de Open
// Verification pra Set Verifier, com o solicitante como verifier.

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';

export async function onRequestPost({ request, env }) {
    try {
        const { requestId, action, rejectReason } = await request.json();
        if (!requestId || !['approve', 'reject'].includes(action)) {
            return json({ error: 'Missing requestId or invalid action.' }, 400);
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

        // 2. Confirm the caller is mod/admin.
        const profileRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`,
            { headers: svcHeaders },
        );
        const profiles = await profileRes.json();
        const role = profiles?.[0]?.role;
        if (role !== 'mod' && role !== 'admin') {
            return json({ error: 'You do not have permission to do this.' }, 403);
        }

        // 3. Load the request.
        const reqRes = await fetch(
            `${SUPABASE_URL}/rest/v1/verifier_requests?id=eq.${requestId}&select=*`,
            { headers: svcHeaders },
        );
        const requests = await reqRes.json();
        const reqRow = requests?.[0];
        if (!reqRow) {
            return json({ error: 'Request not found.' }, 404);
        }
        if (reqRow.status !== 'pending') {
            return json({ error: 'This request was already reviewed.' }, 409);
        }
        if (reqRow.request_type !== 'become_verifier') {
            return json({ error: 'Only "become verifier" requests need review.' }, 400);
        }

        if (action === 'reject') {
            await fetch(`${SUPABASE_URL}/rest/v1/verifier_requests?id=eq.${requestId}`, {
                method: 'PATCH',
                headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({
                    status: 'rejected',
                    reject_reason: rejectReason || null,
                    reviewer_id: user.id,
                    reviewed_at: new Date().toISOString(),
                }),
            });
            await notifyUser(svcHeaders, reqRow.user_id, `Your request to become the Set Verifier was rejected.${rejectReason ? ' Reason: ' + rejectReason : ''}`, '/verifications');
            return json({ success: true });
        }

        // action === 'approve' → convert the level to Set Verifier.
        const owner = env.GITHUB_OWNER;
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || 'main';
        const ghHeaders = {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'rgdl-review-verifier-request',
        };
        const levelFilePath = `data/verifications/${reqRow.level_path}.json`;
        const levelRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (!levelRes.ok) {
            return json({ error: `Level "${reqRow.level_path}" not found.` }, 404);
        }
        const levelData = await levelRes.json();
        const level = JSON.parse(decodeURIComponent(escape(atob(levelData.content))));

        if (level.status !== 'open_verification') {
            return json({ error: 'This level is no longer Open Verification — someone may have beaten this request to it.' }, 409);
        }

        const updatedLevel = { ...level, status: 'set_verifier', verifier: reqRow.username };
        const newContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(updatedLevel, null, 4))));
        const updateRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Verifications: ${reqRow.username} is now Set Verifier for ${level.name}`,
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

        await fetch(`${SUPABASE_URL}/rest/v1/verifier_requests?id=eq.${requestId}`, {
            method: 'PATCH',
            headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
                status: 'approved',
                reviewer_id: user.id,
                reviewed_at: new Date().toISOString(),
            }),
        });

        // Auto-reject any other pending requests for the same level (it's taken now).
        await fetch(
            `${SUPABASE_URL}/rest/v1/verifier_requests?level_path=eq.${encodeURIComponent(reqRow.level_path)}&request_type=eq.become_verifier&status=eq.pending&id=neq.${requestId}`,
            {
                method: 'PATCH',
                headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({
                    status: 'rejected',
                    reject_reason: 'Someone else was approved as the Set Verifier for this level.',
                    reviewer_id: user.id,
                    reviewed_at: new Date().toISOString(),
                }),
            },
        );

        await notifyUser(svcHeaders, reqRow.user_id, `You're now the Set Verifier for "${level.name}"!`, '/verifications');

        return json({ success: true });
    } catch (err) {
        return json({ error: err.message || 'Unexpected error.' }, 500);
    }
}

async function notifyUser(svcHeaders, userId, message, link) {
    try {
        await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
            method: 'POST',
            headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ user_id: userId, type: 'verifier_request_reviewed', message, link }),
        });
    } catch {
        // notificação é best-effort
    }
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
