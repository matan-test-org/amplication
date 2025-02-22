import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuthApp } from '@octokit/oauth-app';
//@octokit/openapi-types constantly fails with linting error "Unable to resolve path to module '@octokit/openapi-types'."
// We currently ignore it and should look deeper into the root cause
// eslint-disable-next-line import/no-unresolved
import { components } from '@octokit/openapi-types';
import { Octokit } from '@octokit/rest';
import { createPullRequest } from 'octokit-plugin-create-pull-request';
import { AmplicationError } from 'src/errors/AmplicationError';
import { GoogleSecretsManagerService } from 'src/services/googleSecretsManager.service';
import { REPO_NAME_TAKEN_ERROR_MESSAGE } from '../git/constants';
import { IGitClient } from '../git/contracts/IGitClient';
import { CreateRepoArgsType } from '../git/contracts/types/CreateRepoArgsType';
import { GitRepo } from '../git/dto/objects/GitRepo';
import { GitUser } from '../git/dto/objects/GitUser';
import { GithubFile } from './dto/githubFile';
import { GithubRepo } from './dto/githubRepo';
import { GithubTokenExtractor } from './utils/tokenExtractor/githubTokenExtractor';

const GITHUB_FILE_TYPE = 'file';

export const GITHUB_CLIENT_ID_VAR = 'GITHUB_CLIENT_ID';
export const GITHUB_CLIENT_SECRET_VAR = 'GITHUB_CLIENT_SECRET';
export const GITHUB_SECRET_SECRET_NAME_VAR = 'GITHUB_SECRET_SECRET_NAME';
export const GITHUB_APP_AUTH_REDIRECT_URI_VAR = 'GITHUB_APP_AUTH_REDIRECT_URI';
export const GITHUB_APP_AUTH_SCOPE_VAR = 'GITHUB_APP_AUTH_SCOPE';
export const MISSING_CLIENT_SECRET_ERROR = `Must provide either ${GITHUB_CLIENT_SECRET_VAR} or ${GITHUB_SECRET_SECRET_NAME_VAR}`;
export const UNEXPECTED_FILE_TYPE_OR_ENCODING = `Unexpected file type or encoding received`;

type DirectoryItem = components['schemas']['content-directory'][number];

@Injectable()
export class GithubService implements IGitClient {
  constructor(
    private readonly configService: ConfigService,
    private readonly googleSecretManagerService: GoogleSecretsManagerService,
    public readonly tokenExtractor: GithubTokenExtractor
  ) {}
  async isRepoExistWithOctokit(
    octokit: Octokit,
    name: string
  ): Promise<boolean> {
    const repos = await this.getUserReposWithOctokit(octokit);
    if (repos.map(repo => repo.name).includes(name)) {
      return true;
    }
    return false;
  }
  async isRepoExist(token: string, name: string): Promise<boolean> {
    const octokit = new Octokit({
      auth: token
    });
    return await this.isRepoExistWithOctokit(octokit, name);
  }
  async createRepo(args: CreateRepoArgsType): Promise<GitRepo> {
    const { input, token } = args;
    const octokit = new Octokit({
      auth: token
    });
    if (await this.isRepoExistWithOctokit(octokit, input.name)) {
      throw new AmplicationError(REPO_NAME_TAKEN_ERROR_MESSAGE);
    }

    return octokit
      .request('POST /user/repos', {
        name: input.name,
        private: !args.input.public,
        // eslint-disable-next-line
        auto_init: true,
        // eslint-disable-next-line
        gitignore_template: 'Node'
      })
      .then(response => {
        const { data: repo } = response;
        //TODO add logger
        // console.log('Repository %s created', repo.full_name);

        return {
          name: repo.name,
          url: repo.html_url,
          private: repo.private,
          fullName: repo.full_name,
          admin: repo.permissions.admin
        };
      });
  }
  async getUserReposWithOctokit(octokit: Octokit): Promise<GitRepo[]> {
    const results = await octokit.repos.listForAuthenticatedUser({
      type: 'all',
      sort: 'updated',
      direction: 'desc'
    });

    return results.data.map(repo => ({
      name: repo.name,
      url: repo.html_url,
      private: repo.private,
      fullName: repo.full_name,
      admin: repo.permissions.admin
    }));
  }
  async getUserRepos(token: string): Promise<GitRepo[]> {
    const octokit = new Octokit({
      auth: token
    });
    return this.getUserReposWithOctokit(octokit);
  }

  async listRepoForAuthenticatedUser(token: string): Promise<GithubRepo[]> {
    const octokit = new Octokit({
      auth: token
    });

    const results = await octokit.repos.listForAuthenticatedUser({
      type: 'all',
      sort: 'updated',
      direction: 'desc'
    });

    return results.data.map(repo => ({
      name: repo.name,
      url: repo.html_url,
      private: repo.private,
      fullName: repo.full_name,
      admin: repo.permissions.admin
    }));
  }

  /**
   * Gets a file from GitHub - Currently only returns the content of a single file and only if it is base64 encoded . Otherwise, returns null
   * @param userName
   * @param repoName
   * @param path
   * @param baseBranchName
   * @param token
   */
  async getFile(
    userName: string,
    repoName: string,
    path: string,
    baseBranchName: string,
    token: string
  ): Promise<GithubFile> {
    const octokit = new Octokit({
      auth: token
    });

    const content = await octokit.repos.getContent({
      owner: userName,
      repo: repoName,
      path,
      ref: baseBranchName ? baseBranchName : undefined
    });

    if (!Array.isArray(content)) {
      const item = content.data as DirectoryItem;

      if (item.type === GITHUB_FILE_TYPE) {
        // Convert base64 results to UTF-8 string
        const buff = Buffer.from(item.content, 'base64');

        const file: GithubFile = {
          content: buff.toString('utf-8'),
          htmlUrl: item.html_url,
          name: item.name,
          path: item.path
        };
        return file;
      }
    }

    throw new Error(UNEXPECTED_FILE_TYPE_OR_ENCODING);
  }

  async createPullRequest(
    userName: string,
    repoName: string,
    modules: { path: string; code: string }[],
    commitName: string,
    commitMessage: string,
    commitDescription: string,
    baseBranchName: string,
    token: string
  ): Promise<string> {
    const myOctokit = Octokit.plugin(createPullRequest);

    const TOKEN = token;
    const octokit = new myOctokit({
      auth: TOKEN
    });

    //do not override files in 'server/src/[entity]/[entity].[controller/resolver/service/module].ts'
    //do not override server/scripts/customSeed.ts
    const doNotOverride = [
      /^server\/src\/[^\/]+\/.+\.controller.ts$/,
      /^server\/src\/[^\/]+\/.+\.resolver.ts$/,
      /^server\/src\/[^\/]+\/.+\.service.ts$/,
      /^server\/src\/[^\/]+\/.+\.module.ts$/,
      /^server\/scripts\/customSeed.ts$/
    ];

    const authFolder = 'server/src/auth';

    const files = Object.fromEntries(
      modules.map(module => {
        if (
          !module.path.startsWith(authFolder) &&
          doNotOverride.some(rx => rx.test(module.path))
        ) {
          return [
            module.path,
            ({ exists }) => {
              // do not create the file if it already exist
              if (exists) return null;

              return module.code;
            }
          ];
        }

        return [module.path, module.code];
      })
    );

    //todo: delete files that are no longer part of the app

    // Returns a normal Octokit PR response
    // See https://octokit.github.io/rest.js/#octokit-routes-pulls-create
    const pr = await octokit.createPullRequest({
      owner: userName,
      repo: repoName,
      title: commitMessage,
      body: commitDescription,
      base: baseBranchName /* optional: defaults to default branch */,
      head: commitName,
      changes: [
        {
          /* optional: if `files` is not passed, an empty commit is created instead */
          files: files,
          // {
          //   'path/to/file1.txt': 'Content for file1',
          //   'path/to/file2.png': {
          //     content: '_base64_encoded_content_',
          //     encoding: 'base64'
          //   },
          //   // deletes file if it exists,
          //   'path/to/file3.txt': null,
          //   // updates file based on current content
          //   'path/to/file4.txt': ({ exists, encoding, content }) => {
          //     // do not create the file if it does not exist
          //     if (!exists) return null;

          //     return Buffer.from(content, encoding)
          //       .toString('utf-8')
          //       .toUpperCase();
          //   }
          // },
          commit: commitName
        }
      ]
    });

    return pr.data.html_url;
  }

  async getOAuthAppAuthorizationUrl(appId: string): Promise<string> {
    const [clientID, clientSecret] = await this.getGithubIdAndSecret();

    const app = new OAuthApp({
      clientId: clientID,
      clientSecret: clientSecret
    });

    const redirectURL: string = this.configService
      .get(GITHUB_APP_AUTH_REDIRECT_URI_VAR)
      .replace('{appId}', appId);
    const scope = this.configService.get(GITHUB_APP_AUTH_SCOPE_VAR);

    const url = app.getAuthorizationUrl({
      redirectUrl: redirectURL,
      state:
        'state123' /**@todo: generate unique URL and save it for later check */,
      scopes: scope
    });

    return url;
  }

  async createOAuthAppAuthorizationToken(
    state: string,
    code: string
  ): Promise<string> {
    const [clientID, clientSecret] = await this.getGithubIdAndSecret();

    const app = new OAuthApp({
      clientId: clientID,
      clientSecret: clientSecret
    });

    const { token } = await app.createToken({
      state: state,
      code: code
    });

    return token;
  }
  async getGithubIdAndSecret(): Promise<[string, string]> {
    const clientID = this.configService.get(GITHUB_CLIENT_ID_VAR);
    const clientSecret = await this.getSecret();
    if (!clientID || !clientSecret)
      throw new Error(MISSING_CLIENT_SECRET_ERROR);
    return [clientID, clientSecret];
  }
  private async getSecret(): Promise<string> {
    const clientSecret = this.configService.get(GITHUB_CLIENT_SECRET_VAR);
    if (clientSecret) {
      return clientSecret;
    }
    const secretName = this.configService.get(GITHUB_SECRET_SECRET_NAME_VAR);
    if (!secretName) {
      throw new Error(MISSING_CLIENT_SECRET_ERROR);
    }
    return this.getSecretFromManager(secretName);
  }
  private async getSecretFromManager(name: string): Promise<string> {
    const secretManager = this.googleSecretManagerService;
    const [version] = await secretManager.accessSecretVersion({ name });
    return version.payload.data.toString();
  }

  async getUser(token: string): Promise<GitUser> {
    const octokit = new Octokit({
      auth: token
    });
    const user = await octokit.users.getAuthenticated();
    return { username: user.data.login };
  }
}
