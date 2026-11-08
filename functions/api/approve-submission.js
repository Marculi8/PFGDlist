// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/approve-submission

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';

const DIR_BY_LIST_TYPE = {
    classic: 'data',
    platformer: 'data/platformer',
    challenge: 'data/challenge',
    impossible: 'data/impossible',
};

export async function onRequestPost({ request, env }) {
    try {
        const { submissionId } = await request.json();
        if (!submissionId) {
            return json({ error: 'Missing submissionId.' }, 400);
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

        // 2. Confirm the caller is mod/admin (service role bypasses RLS —
        //    safe here because we already verified their identity above).
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
        if (role !== 'mod' && role !== 'admin') {
            return json({ error: 'You do not have permission to do this.' }, 403);
        }

        // 3. Load the submission itself.
        const subRes = await fetch(
            `${SUPABASE_URL}/rest/v1/submissions?id=eq.${submissionId}&select=*`,
            {
                headers: {
                    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                },
            },
        );
        const submissions = await subRes.json();
        const submission = submissions?.[0];
        if (!submission) {
            return json({ error: 'Submission not found.' }, 404);
        }
        if (submission.status !== 'pending') {
            return json({ error: 'This submission was already reviewed.' }, 409);
        }

        // 4. Figure out which player name to write into the level's records.
        const submitterRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?id=eq.${submission.user_id}&select=username,list_name`,
            {
                headers: {
                    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                },
            },
        );
        const submitters = await submitterRes.json();
        const submitter = submitters?.[0];
        const playerName = submitter?.list_name || submitter?.username || 'Unknown';
        const shouldSetListName = !submitter?.list_name && submitter?.username;

        // 5. Fetch the current level .json from GitHub.
        const dir = DIR_BY_LIST_TYPE[submission.list_type];
        if (!dir) {
            return json({ error: `Unknown list_type: ${submission.list_type}` }, 400);
        }
        const filePath = `${dir}/${submission.level_name}.json`;
        const owner = env.GITHUB_OWNER;
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || 'main';

        const ghHeaders = {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'rgdl-approve-submission',
        };

        const fileRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`,
            { headers: ghHeaders },
        );
        if (!fileRes.ok) {
            return json(
                { error: `Could not find level file "${filePath}" on GitHub.` },
                404,
            );
        }
        const fileData = await fileRes.json();
        const levelJson = JSON.parse(
            decodeURIComponent(escape(atob(fileData.content))),
        );

        // For Impossible levels: once someone reaches 100%, the level is fully
        // verified and stops accepting new submissions entirely.
        if (submission.list_type === 'impossible') {
            const alreadyVerified = (levelJson.records || []).some((r) => r.percent === 100);
            if (alreadyVerified) {
                return json(
                    { error: 'This level already has a 100% World Record and no longer accepts submissions.' },
                    409,
                );
            }
        }

        // 6. Append the new record.
        levelJson.records = levelJson.records || [];
        levelJson.records.push({
            user: playerName,
            link: submission.completion_link,
            percent: submission.percent,
            hz: submission.hz,
            date: (submission.created_at || new Date().toISOString()).slice(0, 10),
            enjoyment: submission.percent === 100 && typeof submission.enjoyment === 'number' ? submission.enjoyment : null,
        });

        if (submission.list_type === 'impossible') {
            // Order must stay chronological (submission order) — the World
            // Record scoring depends on knowing who reached each % first.
        } else {
            levelJson.records.sort((a, b) => b.percent - a.percent);
        }

        const newContent = JSON.stringify(levelJson, null, 4);
        const newContentB64 = btoa(unescape(encodeURIComponent(newContent)));

        // 7. Commit the change back to GitHub.
        const commitRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
            {
                method: 'PUT',
                headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Add record: ${playerName} - ${submission.level_name} (${submission.percent}%)`,
                    content: newContentB64,
                    sha: fileData.sha,
                    branch,
                }),
            },
        );
        if (!commitRes.ok) {
            const err = await commitRes.text();
            return json({ error: `GitHub commit failed: ${err}` }, 502);
        }

        // 8. If this was the player's first record, their username becomes their
        //    official list_name from now on — keeps the profile in sync with the
        //    name that just got written into the level file.
        if (shouldSetListName) {
            await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${submission.user_id}`, {
                method: 'PATCH',
                headers: {
                    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                    'Content-Type': 'application/json',
                    Prefer: 'return=minimal',
                },
                body: JSON.stringify({ list_name: playerName }),
            });
        }

        // 9. Only now, mark the submission as approved.
        await fetch(`${SUPABASE_URL}/rest/v1/submissions?id=eq.${submissionId}`, {
            method: 'PATCH',
            headers: {
                apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
            },
            body: JSON.stringify({
                status: 'approved',
                reviewer_id: user.id,
                updated_at: new Date().toISOString(),
            }),
        });

        await fetch(`${SUPABASE_URL}/rest/v1/submission_history`, {
            method: 'POST',
            headers: {
                apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
            },
            body: JSON.stringify({
                submission_id: submissionId,
                changed_by: user.id,
                status: 'approved',
                notes: 'Approved and written to GitHub.',
            }),
        });

        await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
            method: 'POST',
            headers: {
                apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
            },
            body: JSON.stringify({
                user_id: submission.user_id,
                type: 'submission_approved',
                message: `Your ${submission.percent}% on "${levelJson.name}" was approved!`,
                link: `/player/${encodeURIComponent(playerName)}`,
            }),
        });

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
