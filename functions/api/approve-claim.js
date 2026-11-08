// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/approve-claim
//
// The direct profiles.update() from the browser (in AdminClaims.js) was silently
// doing nothing: RLS only allows a user to update their own row, so a mod/admin
// updating someone else's profile got 0 rows affected with NO error returned —
// looking like success while writing nothing. This Function uses the service
// role key (after verifying the caller is really mod/admin) to do it reliably.

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';
const STATIC_PLAYERS_URL = 'https://reborndemonlist.pages.dev/data/_players.json';

export async function onRequestPost({ request, env }) {
    try {
        const { requestId } = await request.json();
        if (!requestId) {
            return json({ error: 'Missing requestId.' }, 400);
        }

        // 1. Identify the caller from their Supabase access token.
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

        // 3. Load the claim request itself.
        const reqRes = await fetch(
            `${SUPABASE_URL}/rest/v1/claim_requests?id=eq.${requestId}&select=*`,
            { headers: svcHeaders },
        );
        const claimRequests = await reqRes.json();
        const claimRequest = claimRequests?.[0];
        if (!claimRequest) {
            return json({ error: 'Claim request not found.' }, 404);
        }
        if (claimRequest.status !== 'pending') {
            return json({ error: 'This request was already reviewed.' }, 409);
        }

        // 4. Pull in any legacy static profile data (avatar/bio/socials) to merge in.
        let staticData = null;
        try {
            const staticRes = await fetch(STATIC_PLAYERS_URL);
            if (staticRes.ok) {
                const players = await staticRes.json();
                staticData = (players || []).find(
                    (p) => p.name && p.name.toLowerCase() === claimRequest.list_name.toLowerCase(),
                ) || null;
            }
        } catch {
            // Non-fatal — proceed without static data if this fails.
        }

        const updatePayload = { list_name: claimRequest.list_name };
        if (staticData) {
            if (staticData.avatar) updatePayload.avatar = staticData.avatar;
            if (staticData.bio) updatePayload.bio = staticData.bio;
            if (staticData.youtube) updatePayload.youtube = staticData.youtube;
            if (staticData.twitter) updatePayload.twitter = staticData.twitter;
            if (staticData.discord) updatePayload.discord = staticData.discord;
            if (staticData.videos) updatePayload.videos = staticData.videos;
        }

        // 5. Write the profile — service role bypasses RLS, and we ask Postgres
        //    to hand back the updated row so we can confirm it actually changed.
        const updateRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?id=eq.${claimRequest.user_id}`,
            {
                method: 'PATCH',
                headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
                body: JSON.stringify(updatePayload),
            },
        );
        const updatedRows = await updateRes.json();
        if (!updateRes.ok || !Array.isArray(updatedRows) || updatedRows.length === 0) {
            return json({ error: 'Failed to update the profile — no matching user found.' }, 500);
        }

        // 6. Mark the request itself as approved.
        await fetch(`${SUPABASE_URL}/rest/v1/claim_requests?id=eq.${requestId}`, {
            method: 'PATCH',
            headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
                status: 'approved',
                reviewed_by: user.id,
                reviewed_at: new Date().toISOString(),
            }),
        });

        await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
            method: 'POST',
            headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
                user_id: claimRequest.user_id,
                type: 'claim_approved',
                message: `Your claim for "${claimRequest.list_name}" was approved!`,
                link: `/player/${encodeURIComponent(claimRequest.list_name)}`,
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
