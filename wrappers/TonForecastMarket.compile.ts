import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/ton_forecast_market.tolk',
    withStackComments: true,
    withSrcLineComments: true,
    experimentalOptions: '',
};
