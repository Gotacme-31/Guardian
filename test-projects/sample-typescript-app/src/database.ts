import { PrismaClient } from "@prisma/client";
import runtime from "@prisma/client/runtime/library";

export const databaseImports = { PrismaClient, runtime };
