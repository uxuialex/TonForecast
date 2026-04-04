import { toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { TonForecastMarket } from '../wrappers/TonForecastMarket';

export async function run(provider: NetworkProvider) {
    const senderAddress = provider.sender().address;
    if (!senderAddress) {
        throw new Error('Sender address is required to deploy the contract');
    }

    const ui = provider.ui();
    const resolverAddress = await ui.inputAddress(
        'Resolver address',
        senderAddress,
    );
    const treasuryAddress = await ui.inputAddress(
        'Treasury address',
        senderAddress,
    );
    const defaultSalt = BigInt(Math.floor(Date.now() / 1000));
    const deploymentSaltInput = await ui.input(
        `Deployment salt (default: ${defaultSalt.toString()})`,
    );
    const deploymentSalt = deploymentSaltInput.trim()
        ? BigInt(deploymentSaltInput.trim())
        : defaultSalt;

    const contract = provider.open(
        TonForecastMarket.createFromConfig(
            {
                ownerAddress: senderAddress,
                resolverAddress,
                treasuryAddress,
                deploymentSalt,
            },
            await compile('TonForecastMarket'),
        ),
    );

    await contract.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(contract.address);

    ui.write(`TonForecastMarket deployed at: ${contract.address.toString()}`);
    ui.write(`Owner: ${senderAddress.toString()}`);
    ui.write(`Resolver: ${resolverAddress.toString()}`);
    ui.write(`Treasury: ${treasuryAddress.toString()}`);
    ui.write(`Deployment salt: ${deploymentSalt.toString()}`);
}
