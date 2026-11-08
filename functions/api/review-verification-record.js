// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/review-verification-record
//
// Mod/admin approves or rejects a pending verification_records row.
// Approve at 100%  → level becomes fully Verified (moves sub-tab, gets a date).
// Approve at <100% → level's public % is updated to this record's %.
// Reject           → nothing changes on the level; it keeps its last confirmed %.

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';

export async function onRequestPost({ request, env }) {
    try {
        const { recordId, action, rejectReason } = await request.json();
        if (!recordId || !['approve', 'reject'].includes(action)) {
            return json({ error: 'Missing recordId or invalid action.' }, 400);
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

        // 3. Load the record.
        const recRes = await fetch(
            `${SUPABASE_URL}/rest/v1/verification_records?id=eq.${recordId}&select=*`,
            { headers: svcHeaders },
        );
        const records = await recRes.json();
        const record = records?.[0];
        if (!record) {
            return json({ error: 'Record not found.' }, 404);
        }
        if (record.status !== 'pending') {
            return json({ error: 'This record was already reviewed.' }, 409);
        }

        if (action === 'reject') {
            await fetch(`${SUPABASE_URL}/rest/v1/verification_records?id=eq.${recordId}`, {
                method: 'PATCH',
                headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({
                    status: 'rejected',
                    reject_reason: rejectReason || null,
                    reviewer_id: user.id,
                    reviewed_at: new Date().toISOString(),
                }),
            });
            await notifyUser(svcHeaders, record.user_id, `Your ${record.percent}% report on a Verifications level was rejected.${rejectReason ? ' Reason: ' + rejectReason : ''}`, '/verifications');
            return json({ success: true });
        }

        // action === 'approve' → update the level file on GitHub.
        const owner = env.GITHUB_OWNER;
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || 'main';
        const ghHeaders = {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'rgdl-review-verification-record',
        };
        const levelFilePath = `data/verifications/${record.level_path}.json`;
        const levelRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (!levelRes.ok) {
            return json({ error: `Level "${record.level_path}" not found.` }, 404);
        }
        const levelData = await levelRes.json();
        const level = JSON.parse(decodeURIComponent(escape(atob(levelData.content))));

        const updatedLevel = record.percent === 100
            ? {
                  ...level,
                  percent: 100,
                  status: 'verified',
                  verifier: record.username,
                  verified_date: new Date().toISOString(),
              }
            : { ...level, percent: record.percent };

        const newContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(updatedLevel, null, 4))));
        const updateRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Verifications: approve ${record.username}'s ${record.percent}% on ${level.name}`,
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

        await fetch(`${SUPABASE_URL}/rest/v1/verification_records?id=eq.${recordId}`, {
            method: 'PATCH',
            headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
                status: 'approved',
                reviewer_id: user.id,
                reviewed_at: new Date().toISOString(),
            }),
        });

        const msg = record.percent === 100
            ? `Your verification of "${level.name}" was approved — it's now fully Verified!`
            : `Your ${record.percent}% on "${level.name}" was approved.`;
        await notifyUser(svcHeaders, record.user_id, msg, '/verifications');

        return json({ success: true, verified: record.percent === 100 });
    } catch (err) {
        return json({ error: err.message || 'Unexpected error.' }, 500);
    }
}

async function notifyUser(svcHeaders, userId, message, link) {
    try {
        await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
            method: 'POST',
            headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ user_id: userId, type: 'verification_record_reviewed', message, link }),
        });
    } catch {
        // notificação é best-effort, não deve derrubar a aprovação
    }
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
