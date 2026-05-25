// eslint.config.js (Flat Config 示例)
import typescriptEslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default typescriptEslint.config({
  files: ['**/*.ts'],
  languageOptions: {
    parser: typescriptEslint.parser, // 使用 typescript-eslint 的解析器
  },
  plugins: {
    '@stylistic': stylistic, // 注册 stylistic 插件
  },
  extends: [
    ...typescriptEslint.configs.recommended,      // typescript-eslint 的逻辑规则
    ...typescriptEslint.configs.stylistic,        // typescript-eslint 内置的风格规则（可选）
    // 如果你更喜欢用 @stylistic 插件完全控制风格，可以在这里禁用上面一行的相关规则，
    // 并手动配置 @stylistic 的规则，或使用它的推荐配置。
  ],
  rules: {
    // 示例：配置一个由 @stylistic 负责的规则
    // 示例：配置一个由 typescript-eslint 负责的逻辑规则
    '@typescript-eslint/no-explicit-any': 'warn',
    '@stylistic/indent': ['error', 2],
    '@stylistic/semi': ['error', 'never'],
    // 不使用尾随逗号（多行对象、数组等末尾也不加逗号）
    '@stylistic/comma-dangle': ['error', 'never'],
    '@stylistic/quotes': ['error', 'single', {
      avoidEscape: true,  // 如果字符串内包含单引号，允许使用双引号来避免转义
      allowTemplateLiterals: true // 允许使用模板字符串
    }],
    '@stylistic/quote-props': ['error', 'as-needed'] // 对象属性名按需使用引号
  }
});