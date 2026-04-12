import { prisma } from "../db.js";

export async function getActiveFee() {
  return prisma.feeSetting.findFirst({
    where: { isActive: true },
  });
}

export async function activateFee(id: string) {
  await prisma.$transaction([
    prisma.feeSetting.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    }),
    prisma.feeSetting.update({
      where: { id },
      data: { isActive: true },
    }),
  ]);

  return prisma.feeSetting.findUnique({ where: { id } });
}

export async function deactivateFee(id: string) {
  return prisma.feeSetting.update({
    where: { id },
    data: { isActive: false },
  });
}
