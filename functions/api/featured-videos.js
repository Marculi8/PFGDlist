// Cloudflare Pages Function — runs on Cloudflare's server, NEVER shipped to the browser.
// Route: GET /api/featured-videos
//
// Público (sem auth) — retorna só { level_path: video_link } do MAIOR record
// aprovado de cada fase de Verifications. É a única "brecha" deliberada na
// privacidade dos records: expõe apenas o link do vídeo da % mais alta atual
// de cada fase, nunca o histórico completo, nem quem enviou, nem %s menores.

const SUPABASE_URL = 'https://qqvmrkmpkbemxzhoxjfa.supabase.co';

export async function onRequestGet({ env }) {
    try {
        const svcHeaders = {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        };

        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/verification_records?status=eq.approved&select=level_path,percent,video_link&order=percent.desc`,
            { headers: svcHeaders },
        );
        if (!res.ok) {
            return json({ error: 'Failed to load records.' }, 502);
        }
        const records = await res.json();

        // Como veio ordenado por percent desc, o primeiro que aparecer por
        // level_path já é o maior — não precisa reduzir/comparar.
        const featured = {};
        for (const rec of records) {
            if (!(rec.level_path in featured)) {
                featured[rec.level_path] = rec.video_link;
            }
        }

        return new Response(JSON.stringify(featured), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=60', // atualiza no máx a cada 1min, é ok ficar levemente desatualizado
            },
        });
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
