// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['subagent/src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
  },
);
