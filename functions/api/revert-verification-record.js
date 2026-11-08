// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/revert-verification-record
//
// Mod/admin reverts a previously-approved verification_records row (e.g. found
// cheating on review). Recomputes the level's public % from whatever approved
// records remain. If the reverted record was the one that hit 100% and
// verified the level, the level goes back to Set Verifier / Open Verification
// (inferred from whether it has a Level ID — Open Verification always has one).

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';

export async function onRequestPost({ request, env }) {
    try {
        const { recordId, reason } = await request.json();
        if (!recordId) {
            return json({ error: 'Missing recordId.' }, 400);
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
        if (record.status !== 'approved') {
            return json({ error: 'Only approved records can be reverted.' }, 409);
        }

        // 4. Find the best remaining approved record for this level (if any).
        const remainingRes = await fetch(
            `${SUPABASE_URL}/rest/v1/verification_records?level_path=eq.${encodeURIComponent(record.level_path)}&status=eq.approved&id=neq.${recordId}&select=percent&order=percent.desc&limit=1`,
            { headers: svcHeaders },
        );
        const remaining = await remainingRes.json();
        const newPercent = remaining?.[0]?.percent || 0;

        // 5. Load + update the level file on GitHub.
        const owner = env.GITHUB_OWNER;
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || 'main';
        const ghHeaders = {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'rgdl-revert-verification-record',
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

        const wasTheVerifyingRecord = level.status === 'verified' && record.percent === 100;
        const updatedLevel = wasTheVerifyingRecord
            ? {
                  ...level,
                  percent: newPercent,
                  status: level.id ? 'open_verification' : 'set_verifier', // Open Verification sempre tem ID
                  verifier: level.id ? '' : level.verifier, // Set Verifier mantém o verifier fixo; Open Verification perde o crédito
                  verified_date: null,
              }
            : { ...level, percent: newPercent };

        const newContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(updatedLevel, null, 4))));
        const updateRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Verifications: revert ${record.username}'s ${record.percent}% on ${level.name}`,
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

        // 6. Mark the record as rejected (reverted).
        await fetch(`${SUPABASE_URL}/rest/v1/verification_records?id=eq.${recordId}`, {
            method: 'PATCH',
            headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
                status: 'rejected',
                reject_reason: reason || 'Reverted by mod/admin after review.',
                reviewer_id: user.id,
                reviewed_at: new Date().toISOString(),
            }),
        });

        await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
            method: 'POST',
            headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
                user_id: record.user_id,
                type: 'verification_record_reverted',
                message: `Your ${record.percent}% on "${level.name}" was reverted by a mod/admin.${reason ? ' Reason: ' + reason : ''}`,
                link: '/verifications',
            }),
        }).catch(() => {});

        return json({ success: true, newPercent, unverified: wasTheVerifyingRecord });
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
