# Publishing to npm

The public package is `@testingfloor/js`. Releases come from
`capitalisminc/testingfloor-sdk-js` using `.github/workflows/publish.yml`.
Run the commands below from an up-to-date, clean checkout of `main`, using
Node.js 24 and an npm account with publishing rights to the `@testingfloor` scope.

## First publish

The package must exist on npm before a trusted publisher can be configured.
The first release therefore uses an authenticated local publish.

```sh
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm ci
npm run typecheck
npm test
npm run test:package
npm publish --access public --registry=https://registry.npmjs.org
```

Complete the account's browser and two-factor authentication prompts when
requested. The publish command releases the version in `package.json`; confirm
that version and the package contents before approving the publish. Public
visibility and the npm registry are also set in `publishConfig`.

Verify the release from an empty temporary directory outside this checkout:

```sh
npm init -y
npm install @testingfloor/js@0.3.0
node --input-type=module -e "import { createTestingFloor } from '@testingfloor/js'; console.log(typeof createTestingFloor)"
node -e "console.log(typeof require('@testingfloor/js/browser').createTestingFloor)"
```

Both import checks should print `function`. The commands above use the initial
version; use the version just published when checking a later release.

## Configure trusted publishing with the CLI

The `npm trust` command requires npm 11.15.0 or newer, account-level two-factor
authentication, and write access to the existing package. This command runs a
compatible npm temporarily without changing the globally installed CLI:

```sh
npx --yes npm@11.21.2 trust github @testingfloor/js \
  --repo=capitalisminc/testingfloor-sdk-js \
  --file=publish.yml \
  --allow-publish
npx --yes npm@11.21.2 trust list @testingfloor/js
```

Complete any authentication prompts. This configures direct publishing from the
GitHub workflow, without adding a long-lived npm publish token to GitHub. No
environment name is needed because the workflow does not use a GitHub environment.
The CLI avoids the website's trusted-publisher form, but authentication may still
open a browser.

If a connection already exists, inspect it with `trust list` before changing it.
A new connection needs its first successful workflow publish within two days;
an expired connection must be replaced before it can be used. Configuration
alone does not verify that the workflow can publish.

See npm's [CLI reference](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
and [trusted-publishing guide](https://docs.npmjs.com/trusted-publishers/).

## Later releases

Update the version in `package.json`, the lockfile, and `SDK_VERSION` in
`src/client.ts` together. Update the changelog, run the checks above, and commit
the release to `main`. Push a new matching `v<version>` tag to run `publish.yml`.
The workflow also supports a manual run for an unpublished version on `main`.
Each npm package version can be published only once, so a version already
published locally needs a new version before the next workflow release.

The workflow uses Node.js 24, GitHub-hosted runners, `id-token: write`, and
`npm publish --provenance --access public`. Verify the first workflow release
and its provenance on npm before relying on automated publishing.

## Retire the old browser package

After the new package passes the install and import checks, deprecate the old
package with a migration notice:

```sh
npm deprecate '@testingfloor/browser@*' \
  'Moved to @testingfloor/js. Browser apps should import from @testingfloor/js/browser.' \
  --registry=https://registry.npmjs.org
npm view @testingfloor/browser deprecated --registry=https://registry.npmjs.org
```

Deprecation leaves the old versions available and displays the notice during
installation, so existing projects can migrate on their own schedule. It does
not redirect installations or change application imports. The account must own
the old package. See npm's [deprecation reference](https://docs.npmjs.com/cli/v11/commands/npm-deprecate/).
