import { PrismaClient } from "@prisma/client";
import runtime from "@prisma/client/runtime/library";

const prisma = new PrismaClient();

export const users = prisma.user.findMany();
export const order = prisma.order.create({ data: {} });
export const databaseImports = { PrismaClient, runtime };
