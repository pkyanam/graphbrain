// Next.js config for the Graphbrain dashboard.
//
// The dashboard is a pure consumer of the API service (api.graphbrain.belweave.ai).
// The API is a Bearer-token API (Clerk JWT), not a cookie API, so no CORS or
// rewrites are needed — the browser calls the API directly with the JWT in the
// Authorization header. Keep this minimal.
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
