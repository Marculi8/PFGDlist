// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: POST /api/rename-player
//
// Lets an authenticated player who has already claimed a profile change their
// display name across the site. Does an EXHAUSTIVE scan of every level file
// (not GitHub's code search, which can silently miss matches). Every GitHub
// request is retried a couple times, and if it still fails the WHOLE request
// aborts with a visible error — no file is ever silently skipped, which is
// what previously caused a rename to only partially complete without any
// error being shown.
//
// Phase "scan"  (read-only): walks every level file once, collecting which
//                ones mention the OLD name (to update later) and aborting
//                immediately if any file already mentions the NEW name.
// Phase "write": only the files collected during scan get fetched again and
//                committed with the name swapped in.
//
// First call:        { newName }
// Continuation call:  echo back exactly what the previous response sent you,
//                      plus newName: { newName, oldName, phase, scanQueue?, updateQueue? }

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gy8sGfe7-_kjn2V4iH5RBA_Pto2Ruqk';
const COOLDOWN_DAYS = 7;
const SCAN_BATCH_SIZE = 25; // read-only (1 subrequest per file)
const WRITE_BATCH_SIZE = 15; // read + write (2 subrequests per file)

const LIST_CONFIG = {
    classic: { dir: 'data', listFile: 'data/_list.json' },
    platformer: { dir: 'data/platformer', listFile: 'data/platformer/_platformer_list.json' },
    challenge: { dir: 'data/challenge', listFile: 'data/challenge/_challenge_list.json' },
    impossible: { dir: 'data/impossible', listFile: 'data/impossible/_impossible_list.json' },
    verifications: { dir: 'data/verifications', listFile: 'data/verifications/_verifications_list.json' },
};

// Retries a fetch up to `retries` extra times before giving up. Never silently
// swallows a failure — callers get either a working Response or a thrown Error.
async function fetchWithRetry(url, options, retries = 2) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, options);
            if (res.ok) return res;
            lastErr = new Error(`GitHub request failed (${res.status}) for ${url}`);
        } catch (err) {
            lastErr = err;
        }
        if (i < retries) {
            await new Promise((r) => setTimeout(r, 300 * (i + 1)));
        }
    }
    throw lastErr;
}

async function fetchLevelJson(owner, repo, branch, path, ghHeaders) {
    const res = await fetchWithRetry(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
        { headers: ghHeaders },
    );
    const fileData = await res.json();
    let level;
    try {
        level = JSON.parse(decodeURIComponent(escape(atob(fileData.content))));
    } catch {
        throw new Error(`Could not parse ${path} as JSON.`);
    }
    return { level, sha: fileData.sha };
}

export async function onRequestPost({ request, env }) {
    try {
        const body = await request.json();
        const newName = (body.newName || '').trim();

        if (!newName || newName.length < 2 || newName.length > 32) {
            return json({ error: 'Name must be between 2 and 32 characters.' }, 400);
        }

        // Identify the caller from their Supabase access token (every call).
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

        const owner = env.GITHUB_OWNER;
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || 'main';
        const ghHeaders = {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'rgdl-rename-player',
        };

        let oldName;
        let phase;
        let scanQueue;
        let updateQueue;

        if (!body.phase) {
            // ===== FIRST CALL: validate, then build the full scan queue =====
            const profileRes = await fetch(
                `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=list_name,name_changed_at`,
                { headers: svcHeaders },
            );
            const ownProfiles = await profileRes.json();
            const ownProfile = ownProfiles?.[0];
            if (!ownProfile || !ownProfile.list_name) {
                return json({ error: 'Claim your profile before renaming it.' }, 403);
            }

            oldName = ownProfile.list_name;

            if (oldName.toLowerCase() === newName.toLowerCase()) {
                return json({ error: 'That is already your name.' }, 400);
            }

            if (ownProfile.name_changed_at) {
                const last = new Date(ownProfile.name_changed_at).getTime();
                const daysSince = (Date.now() - last) / (1000 * 60 * 60 * 24);
                if (daysSince < COOLDOWN_DAYS) {
                    const daysLeft = Math.ceil(COOLDOWN_DAYS - daysSince);
                    return json(
                        { error: `You can change your name again in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.` },
                        429,
                    );
                }
            }

            const takenRes = await fetch(
                `${SUPABASE_URL}/rest/v1/profiles?list_name=ilike.${encodeURIComponent(newName)}&select=id`,
                { headers: svcHeaders },
            );
            const takenRows = await takenRes.json();
            if ((takenRows || []).some((p) => p.id !== user.id)) {
                return json({ error: 'That name is already taken by a registered account.' }, 409);
            }

            // Build the full list of every level file path across all 4 categories.
            // Any failure here is fatal — a half-built queue means a half-finished rename.
            scanQueue = [];
            for (const { dir, listFile } of Object.values(LIST_CONFIG)) {
                const res = await fetchWithRetry(
                    `https://api.github.com/repos/${owner}/${repo}/contents/${listFile}?ref=${branch}`,
                    { headers: ghHeaders },
                );
                const data = await res.json();
                const paths = JSON.parse(decodeURIComponent(escape(atob(data.content))));
                paths.forEach((p) => scanQueue.push(`${dir}/${p}.json`));
            }

            phase = 'scan';
            updateQueue = [];
            var totalScanFiles = scanQueue.length;
            var scannedSoFar = 0;
        } else {
            // ===== CONTINUATION CALL =====
            oldName = body.oldName;
            phase = body.phase;
            scanQueue = body.scanQueue || [];
            updateQueue = body.updateQueue || [];
            var totalScanFiles = body.totalScanFiles || 0;
            var scannedSoFar = body.scannedSoFar || 0;
            var totalWriteFiles = body.totalWriteFiles || 0;
            var writtenSoFar = body.writtenSoFar || 0;
            if (!oldName) {
                return json({ error: 'Missing continuation state.' }, 400);
            }
        }

        const matches = (v, name) => typeof v === 'string' && v.toLowerCase() === name.toLowerCase();
        const fieldsMatch = (level, name) =>
            matches(level.author, name) ||
            matches(level.verifier, name) ||
            (Array.isArray(level.creators) && level.creators.some((c) => matches(c, name))) ||
            (Array.isArray(level.records) && level.records.some((r) => matches(r.user, name)));

        // ===== SCAN PHASE: read-only, find matches, abort on collision =====
        if (phase === 'scan') {
            const batch = scanQueue.slice(0, SCAN_BATCH_SIZE);
            const rest = scanQueue.slice(SCAN_BATCH_SIZE);

            for (const path of batch) {
                // No try/catch here on purpose: if this throws after retries,
                // it bubbles up to the outer catch and the whole rename aborts
                // with a visible error instead of quietly skipping the file.
                const { level } = await fetchLevelJson(owner, repo, branch, path, ghHeaders);
                scannedSoFar++;

                if (fieldsMatch(level, newName)) {
                    return json({ error: 'That name is already in use on the list.' }, 409);
                }
                if (fieldsMatch(level, oldName)) {
                    updateQueue.push(path);
                }
            }

            if (rest.length > 0) {
                return json({
                    success: true,
                    done: false,
                    filesUpdated: 0,
                    oldName,
                    newName,
                    phase: 'scan',
                    scanQueue: rest,
                    updateQueue,
                    totalScanFiles,
                    scannedSoFar,
                    progressLabel: `Scanned ${scannedSoFar}/${totalScanFiles} files, ${updateQueue.length} match so far`,
                });
            }

            // Scan finished — move on to the write phase (or finish immediately if nothing to update).
            if (updateQueue.length === 0) {
                await finalizeProfile(SUPABASE_URL, svcHeaders, user.id, newName);
                return json({ success: true, done: true, filesUpdated: 0 });
            }

            return json({
                success: true,
                done: false,
                filesUpdated: 0,
                oldName,
                newName,
                phase: 'write',
                updateQueue,
                totalWriteFiles: updateQueue.length,
                writtenSoFar: 0,
                progressLabel: `Scan complete: ${updateQueue.length} files to update. Starting writes...`,
            });
        }

        // ===== WRITE PHASE: only the files flagged during scan =====
        const batch = updateQueue.slice(0, WRITE_BATCH_SIZE);
        const rest = updateQueue.slice(WRITE_BATCH_SIZE);

        // First, figure out which files in this batch actually need changes —
        // no commits yet.
        const changedFiles = [];
        for (const path of batch) {
            const { level } = await fetchLevelJson(owner, repo, branch, path, ghHeaders);

            let changed = false;
            if (matches(level.author, oldName)) {
                level.author = newName;
                changed = true;
            }
            if (Array.isArray(level.creators)) {
                const newCreators = level.creators.map((c) => (matches(c, oldName) ? newName : c));
                if (newCreators.some((c, i) => c !== level.creators[i])) {
                    level.creators = newCreators;
                    changed = true;
                }
            }
            if (matches(level.verifier, oldName)) {
                level.verifier = newName;
                changed = true;
            }
            if (Array.isArray(level.records)) {
                const newRecords = level.records.map((r) =>
                    matches(r.user, oldName) ? { ...r, user: newName } : r,
                );
                if (newRecords.some((r, i) => r.user !== level.records[i].user)) {
                    level.records = newRecords;
                    changed = true;
                }
            }

            if (!changed) continue; // legitimately nothing to write for this file — not a failure
            changedFiles.push({ path, content: JSON.stringify(level, null, 4) });
        }

        let filesUpdated = 0;
        if (changedFiles.length > 0) {
            // Bundle every changed file in this batch into ONE commit via the
            // Git Trees API, instead of one commit (and one Pages deployment)
            // per file — a batch of 15 would otherwise queue 15 deployments.
            const refRes = await fetchWithRetry(
                `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,
                { headers: ghHeaders },
            );
            const refData = await refRes.json();
            const latestCommitSha = refData.object.sha;

            const baseCommitRes = await fetchWithRetry(
                `https://api.github.com/repos/${owner}/${repo}/git/commits/${latestCommitSha}`,
                { headers: ghHeaders },
            );
            const baseCommitData = await baseCommitRes.json();
            const baseTreeSha = baseCommitData.tree.sha;

            const treeEntries = [];
            for (const { path, content } of changedFiles) {
                const blobRes = await fetchWithRetry(
                    `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
                    {
                        method: 'POST',
                        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            content: btoa(unescape(encodeURIComponent(content))),
                            encoding: 'base64',
                        }),
                    },
                );
                const blobData = await blobRes.json();
                treeEntries.push({ path, mode: '100644', type: 'blob', sha: blobData.sha });
            }

            const treeRes = await fetchWithRetry(
                `https://api.github.com/repos/${owner}/${repo}/git/trees`,
                {
                    method: 'POST',
                    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
                },
            );
            const treeData = await treeRes.json();

            const newCommitRes = await fetchWithRetry(
                `https://api.github.com/repos/${owner}/${repo}/git/commits`,
                {
                    method: 'POST',
                    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: `Rename "${oldName}" to "${newName}" in ${changedFiles.length} file(s)`,
                        tree: treeData.sha,
                        parents: [latestCommitSha],
                    }),
                },
            );
            const newCommitData = await newCommitRes.json();

            // This is the only step that actually triggers a deployment — once per batch.
            await fetchWithRetry(
                `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,
                {
                    method: 'PATCH',
                    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sha: newCommitData.sha }),
                },
            );

            filesUpdated = changedFiles.length;
            writtenSoFar += filesUpdated;
        }

        if (rest.length > 0) {
            return json({
                success: true,
                done: false,
                filesUpdated,
                oldName,
                newName,
                phase: 'write',
                updateQueue: rest,
                totalWriteFiles,
                writtenSoFar,
                progressLabel: `Wrote ${writtenSoFar}/${totalWriteFiles} files`,
            });
        }

        await finalizeProfile(SUPABASE_URL, svcHeaders, user.id, newName);
        return json({ success: true, done: true, filesUpdated });
    } catch (err) {
        return json({ error: err.message || 'Unexpected error.' }, 500);
    }
}

async function finalizeProfile(SUPABASE_URL, svcHeaders, userId, newName) {
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
        method: 'PATCH',
        headers: { ...svcHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
            list_name: newName,
            name_changed_at: new Date().toISOString(),
        }),
    });
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
