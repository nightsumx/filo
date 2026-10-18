import antfu from '@antfu/eslint-config'

// 只查会出错的写法，不管格式：仓库里缩进、分号、import 顺序并不统一，
// 查格式会得到几千条与行为无关的告警，真问题反而看不见。
export default antfu({
    type: 'app',
    stylistic: false,
    jsonc: false,
    yaml: false,
    ignores: ['dist', 'dist-electron', 'release', 'build', '.claude', 'node_modules', '**/*.md'],
    rules: {
        'no-console': 'off',
        'unused-imports/no-unused-vars': 'off',
        'no-unmodified-loop-condition': 'off',
        'node/prefer-global/process': 'off',
        'node/prefer-global/buffer': 'off',
        'perfectionist/sort-imports': 'off',
        'perfectionist/sort-named-imports': 'off',
        'perfectionist/sort-exports': 'off',
        'perfectionist/sort-named-exports': 'off',
        'import/order': 'off',
        'antfu/top-level-function': 'off',
        'antfu/if-newline': 'off',
        'antfu/curly': 'off',
        'ts/no-use-before-define': 'off',
        'test/prefer-lowercase-title': 'off',
        'regexp/no-unused-capturing-group': 'off',
        'import/consistent-type-specifier-style': 'off',
        'prefer-arrow-callback': 'off',
        'unicorn/escape-case': 'off',
        'unicorn/number-literal-case': 'off',
        'ts/method-signature-style': 'off',
        'ts/consistent-type-definitions': 'off',
        'one-var': 'off',
        'antfu/no-top-level-await': 'off',
        // 终端转义序列、`while ((m = re.exec(s)))` 都是有意写成这样的
        // 测试里用 gateway['hooks'] 取私有成员，TypeScript 只认这种写法
        'dot-notation': 'off',
        // some(x => x === api) 是为了让只读元组接受更宽的类型，includes 过不了类型检查
        'unicorn/prefer-includes': 'off',
        'no-control-regex': 'off',
        'import/no-mutable-exports': 'off',
        'no-cond-assign': 'off',
        'no-template-curly-in-string': 'off',
        'prefer-template': 'off',
        'regexp/no-obscure-range': 'off',
        'regexp/no-dupe-characters-character-class': 'off',
        'regexp/use-ignore-case': 'off',
        'regexp/prefer-character-class': 'off',
    },
})
