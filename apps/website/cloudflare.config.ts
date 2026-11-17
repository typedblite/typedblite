// Deploy the built site (dist/) as an assets-only Worker:
//   npm exec nx -- run website:build-site && cd apps/website && npx cf@latest deploy ./dist
// A plain object, so the file needs no `cf` dependency to load.
export default {
  worker: {
    name: 'typedblite-website',
    compatibilityDate: '2026-11-17',
    workersDev: true,
    domains: ['typedblite.dev'],
    assets: { notFoundHandling: '404-page' },
  },
};
