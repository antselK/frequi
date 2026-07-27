import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

import createVuePlugin from '@vitejs/plugin-vue';
import ui from '@nuxt/ui/vite';
import { execSync } from 'child_process';
import { resolve } from 'path';
import IconsResolve from 'unplugin-icons/resolver';
import Icons from 'unplugin-icons/vite';
import VueRouter from 'vue-router/vite';

let commitHash: string = 'unknown';
try {
  commitHash = execSync('git rev-parse --short HEAD').toString();
} catch (error) {
  console.error('Failed to get commit hash. Running in this mode will not be supported.');
}

// Dev proxy → control-plane. In production nginx routes same-origin /api/v1/ to the
// control-plane with X-Admin-Token; mirror that here so `pnpm dev` reaches VPS/DWH/Reports.
// Set CONTROL_PLANE_BASE_URL (default 127.0.0.1:8000 for local dev) and
// CONTROL_PLANE_ADMIN_TOKEN in .env to authenticate; without a token the API returns 401.
const cpEnv = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), '');
const controlPlaneProxy = {
  target: cpEnv.CONTROL_PLANE_BASE_URL || 'http://127.0.0.1:8000',
  changeOrigin: true,
  ...(cpEnv.CONTROL_PLANE_ADMIN_TOKEN
    ? { headers: { 'X-Admin-Token': cpEnv.CONTROL_PLANE_ADMIN_TOKEN } }
    : {}),
};

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
  plugins: [
    // Must be registered before the Vue plugin so it can transform route blocks.
    VueRouter({
      routesFolder: 'src/pages',
      dts: 'src/typed-router.d.ts',
    }),
    createVuePlugin({
      script: {
        defineModel: true,
      },
    }),
    ui({
      ui: {
        colors: {
          primary: 'brand',
          // slate, gray or mist
          neutral: 'mist',
        },
        alert: {
          defaultVariants: {
            variant: 'subtle',
          },
        },
        button: {
          defaultVariants: {
            variant: 'subtle',
          },
        },
        table: {
          slots: {
            td: 'px-2 py-2 text-default text-md text-left',
            th: 'px-2 py-2 text-default text-md',
          },
        },
        tabs: {
          variants: {
            variant: {
              link: {
                trigger: 'grow focus:outline-none',
              },
            },
          },
        },
      },
      autoImport: {
        imports: ['vue', 'vue-router', '@vueuse/core', 'pinia'],
        dts: 'src/auto-imports.d.ts',
        dirs: ['src/composables', 'src/stores', 'src/utils/**'],
        vueTemplate: true,
      },
      components: {
        resolvers: [IconsResolve()],
        dts: 'src/components.d.ts',
      },
    }),
    Icons({
      compiler: 'vue3',
    }),
  ],
  resolve: {
    dedupe: ['vue'],
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 700, // Default is 500
    sourcemap: false,
  },
  server: {
    proxy: {
      // Control-plane API (VPS/DWH/Reports/SSE) — must be listed before '/api' so it wins.
      '/api/v1': controlPlaneProxy,
      // Upstream default: any other /api path proxies to a co-located freqtrade bot.
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
    host: '127.0.0.1',
    port: 3000,
  },
  test: {
    environment: 'happy-dom',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
    ],
  },
});
