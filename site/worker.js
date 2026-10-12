// filoapp.dev: the static site, plus /download/<file> from the R2 bucket. scripts/release.sh puts
// each version's files under v<version>/ and then writes that version into `latest`, so a download
// always gets one complete release.
export default {
    async fetch(request, env) {
        const url = new URL(request.url)
        if (!url.pathname.startsWith('/download/'))
            return env.ASSETS.fetch(request)
        const name = url.pathname.slice('/download/'.length)
        const latest = await env.RELEASES.get('latest')
        const object = latest && name && !name.includes('/') && await env.RELEASES.get(`v${(await latest.text()).trim()}/${name}`)
        if (!object)
            return new Response('Not found\n', { status: 404 })
        const headers = new Headers({
            'content-length': String(object.size),
            'etag': object.httpEtag,
            'cache-control': 'public, max-age=300',
        })
        object.writeHttpMetadata(headers)
        if (!name.endsWith('.sha256'))
            headers.set('content-disposition', `attachment; filename="${name}"`)
        return new Response(object.body, { headers })
    },
}
