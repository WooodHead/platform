import { dev } from "$app/env";
import {
  serialize as serializeCookie,
  type CookieSerializeOptions,
} from "cookie";
import { sign as signCookie } from "cookie-signature";
import { sign as signJwt } from "jsonwebtoken";
import { Octokit } from "@octokit/core";
import { createOAuthUserAuth } from "@octokit/auth-oauth-user";
import PrismaClient from "$lib/db/prisma";
import { Prisma, type User as PrismaUser } from "@prisma/client";
import {
  cloneTemplateRepositoryMutation,
  queryRepository,
} from "$lib/github/graphql-api";

import {
  createRepositorySecret as createRepositorySecretRest,
  getRepositorySecret,
} from "$lib/github/rest-api";

const db = new PrismaClient();

const throwInProdIfNotSet = (devValue: string) => {
  if (dev) {
    return devValue;
  }
  throw new Error(`Environment variable not set. Dev value: ${devValue}`);
};

const cookieConfig: CookieSerializeOptions = {
  path: "/",
  maxAge: 1000 * 60 * 60 * 24 * 7,
  httpOnly: true,
  sameSite: true,
  secure: true,
};

const {
  COOKIE_SECRET = throwInProdIfNotSet("cookie-dev-secret"),
  GITHUB_CLIENT_ID = throwInProdIfNotSet("github-client-id"),
  GITHUB_CLIENT_SECRET = throwInProdIfNotSet("cookie-dev-secret"),
  JWT_SECRET = throwInProdIfNotSet("jwt-dev-secret"),
} = process.env;

export const cloneTemplateRepository = async (
  userOctokit: Octokit,
  gitHubUser: User
): Promise<void> => {
  await cloneTemplateRepositoryMutation(userOctokit, gitHubUser.id);
  for (let i = 1; i <= 5; i++) {
    // Let's talk about this loop... creating a repo based on a template is an asynchronous operation.
    // This not-so-elegant loop waits for GitHub to complete that operation.
    // Yes, I agree. This should be cleaned up at some point.
    console.log(
      `Waiting for repository ${gitHubUser.providerLogin}/webstone-education to be created... ${i}/5`
    );
    if (
      await doesRepositoryExist(
        userOctokit,
        gitHubUser.providerLogin,
        "webstone-education"
      )
    ) {
      console.log(
        `Repository ${gitHubUser.providerLogin}/webstone-education is created.`
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error(
    new Error(
      `Repository could not be created for student ${gitHubUser.providerLogin} from template.`
    )
  );
};

export const createUser = async (user: User): Promise<PrismaUser> => {
  let persistedUser: PrismaUser;
  try {
    persistedUser = await db.user.create({
      data: {
        name: user.name || "",
        provider: user.provider,
        provider_email: user.providerEmail,
        provider_id: user.providerId,
        provider_login: user.providerLogin,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // https://www.prisma.io/docs/reference/api-reference/error-reference
      if (error.code === "P2002") {
        const tempDbUser = await db.user.findFirst({
          where: {
            provider: user.provider,
            provider_id: user.providerId,
          },
        });
        if (tempDbUser) {
          persistedUser = await db.user.update({
            where: {
              id: tempDbUser.id,
            },
            data: {
              last_login_at: new Date(),
            },
          });
        }
      } else {
        console.error(
          `Unexpected error when processing the GitHub callback GET handler: ${String(
            error
          )}`
        );
      }
    } else {
      console.error(
        `Unexpected error when processing the GitHub callback GET handler: ${String(
          error
        )}`
      );
    }
  }
  return persistedUser;
};

export const doesRepositoryExist = async (
  userOctokit: Octokit,
  owner: string,
  name: string
): Promise<boolean> => {
  try {
    await queryRepository(userOctokit, owner, name);
    return true;
  } catch (error) {
    return false;
  }
};

export const getUserOctokit = async (code: string): Promise<Octokit> => {
  const webflowOctokit = new Octokit({
    authStrategy: createOAuthUserAuth,
    auth: {
      clientId: GITHUB_CLIENT_ID,
      clientSecret: GITHUB_CLIENT_SECRET,
      code,
    },
  });

  const auth = (await webflowOctokit.auth()) as { token: string };
  return new Octokit({
    auth: auth.token,
  });
};

export const getSystemOctokit = () =>
  new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

export const hasPreordered = async (
  preorderId: string,
  gitHubUsername: string
): Promise<boolean> => {
  const count = await db.preorder.count({
    where: {
      id: preorderId,
      form_github_username: gitHubUsername,
    },
  });

  return count >= 1;
};

export const signJwtAndSerializeCookie = (
  payload: Record<string, unknown>
): Promise<string> => {
  return new Promise((resolve, reject) => {
    signJwt(payload, JWT_SECRET, (error, token = "") => {
      if (error) {
        console.error(error);
        reject();
      }
      const value = `s:${signCookie(token, COOKIE_SECRET)}`;
      const serializedCookie = serializeCookie("jwt", value, cookieConfig);
      resolve(serializedCookie);
    });
  });
};

export const createRepositorySecret = async (
  systemOctokit: Octokit,
  owner: string,
  repo: string,
  secretName: string,
  value: string
): Promise<void> => {
  await createRepositorySecretRest(
    systemOctokit,
    owner,
    repo,
    secretName,
    value
  );
  for (let i = 1; i <= 5; i++) {
    // Let's talk about this loop... creating a repo secret is an asynchronous operation.
    // This not-so-elegant loop waits for GitHub to complete that operation.
    // Yes, I agree. This should be cleaned up at some point.
    console.log(
      `Waiting for secret ${secretName} to be added to repository ${owner}/${repo} to be created... ${i}/5`
    );
    if (await getRepositorySecret(systemOctokit, owner, repo, secretName)) {
      console.log(
        `Secret ${secretName} created in repository ${owner}/${repo}.`
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error(
    new Error(
      `Secret ${secretName} could not be created in repository ${owner}/${repo}.`
    )
  );
};