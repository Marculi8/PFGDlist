// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/submit-verification-progress
//
// Handles a player reporting a new % on a Verifications level:
// - Set Verifier, %<100:  applied immediately (self-trusted), but still
//   logged as an 'approved' record for audit/reversal.
// - Set Verifier, %=100:  NOT applied immediately — goes to 'pending' for
//   an admin to check the footage first.
// - Open Verification, any %: always 'pending' — a mod/admin must approve.

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';

export async function onRequestPost({ request, env }) {
    try {
        const { levelPath, percent, videoLink } = await request.json();
        const percentNum = Number(percent);

        if (!levelPath || !percentNum || percentNum < 1 || percentNum > 100) {
            return json({ error: 'Missing or invalid level/percent.' }, 400);
        }
        if (!videoLink || !videoLink.trim()) {
            return json({ error: 'A video/raw footage link is required.' }, 400);
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

        // 2. Load the caller's profile (need their display name).
        const profileRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=list_name,username`,
            { headers: svcHeaders },
        );
        const profiles = await profileRes.json();
        const profile = profiles?.[0];
        const displayName = profile?.list_name || profile?.username;
        if (!displayName) {
            return json({ error: 'You need to claim your profile / set a list name first.' }, 400);
        }

        // 3. Load the level from GitHub.
        const owner = env.GITHUB_OWNER;
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || 'main';
        const ghHeaders = {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'rgdl-submit-verification-progress',
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

        if (level.status === 'verified') {
            return json({ error: 'This level is already fully verified and no longer accepts submissions.' }, 409);
        }
        if (percentNum <= (level.percent || 0)) {
            return json({ error: `Percent must be higher than the current ${level.percent || 0}%.` }, 400);
        }

        const isSetVerifier = level.status === 'set_verifier';
        if (isSetVerifier && (level.verifier || '').toLowerCase() !== displayName.toLowerCase()) {
            return json({ error: 'You are not the assigned verifier for this level.' }, 403);
        }

        // Set Verifier + not 100% → self-trusted, applies immediately.
        // Everything else (Open Verification of any %, or hitting 100% at all)
        // needs a mod/admin to check the footage first.
        const autoApprove = isSetVerifier && percentNum < 100;

        // 4. Log the record in Supabase (private — only this player + mod/admin can see it).
        const recordRes = await fetch(`${SUPABASE_URL}/rest/v1/verification_records`, {
            method: 'POST',
            headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
            body: JSON.stringify({
                level_path: levelPath,
                user_id: user.id,
                username: displayName,
                percent: percentNum,
                video_link: videoLink.trim(),
                status: autoApprove ? 'approved' : 'pending',
                reviewer_id: autoApprove ? user.id : null,
                reviewed_at: autoApprove ? new Date().toISOString() : null,
            }),
        });
        if (!recordRes.ok) {
            const err = await recordRes.text();
            return json({ error: `Failed to log record: ${err}` }, 502);
        }

        // 5. If self-trusted, apply the new % to the public level file right away.
        if (autoApprove) {
            const updatedLevel = { ...level, percent: percentNum };
            const newContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(updatedLevel, null, 4))));
            const updateRes = await fetch(
                `https://api.github.com/repos/${owner}/${repo}/contents/${levelFilePath}`,
                {
                    method: 'PUT',
                    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: `Verifications: ${level.name} — ${displayName} now at ${percentNum}%`,
                        content: newContentB64,
                        sha: levelData.sha,
                        branch,
                    }),
                },
            );
            if (!updateRes.ok) {
                const err = await updateRes.text();
                return json({ error: `Record was logged, but failed to update the level file: ${err}` }, 502);
            }
        } else {
            // Notify staff there's something to review.
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
                            type: 'new_verification_record',
                            message: `${displayName} reported ${percentNum}% on "${level.name}" (Verifications) — needs review.`,
                            link: '/verifications',
                        })),
                    ),
                });
            }
        }

        return json({ success: true, autoApplied: autoApprove });
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
