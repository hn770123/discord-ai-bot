import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// TypeScript の型情報を利用し、Worker とテストを同じ品質基準で検査する。
export default tseslint.config(
  { ignores: ['coverage/', 'dist/', '.wrangler/', 'worker-configuration.d.ts'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
