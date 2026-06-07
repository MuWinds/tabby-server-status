const path = require('path')

module.exports = {
    target: 'node',
    entry: './src/index.ts',
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    devtool: 'source-map',
    context: __dirname,
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'index.js',
        pathinfo: true,
        library: {
            type: 'umd',
        },
    },
    resolve: {
        extensions: ['.ts', '.js'],
        modules: ['node_modules', 'src'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                loader: 'ts-loader',
                options: { transpileOnly: true },
            },
            {
                test: /\.pug$/,
                use: [
                    { loader: 'apply-loader' },
                    { loader: 'pug-loader' },
                ],
            },
            {
                test: /\.scss$/,
                use: [
                    'to-string-loader',
                    'css-loader',
                    'sass-loader',
                ],
            },
        ],
    },
    externals: [
        'tabby-core',
        'tabby-ssh',
        'tabby-terminal',
        'russh',
        '@angular/core',
        '@angular/common',
        'rxjs',
        'rxjs/operators',
        /^@angular/,
    ],
}
