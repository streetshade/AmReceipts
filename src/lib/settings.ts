// System-wide settings an admin controls.

import { prisma } from "./db";

export const UI_VERSION_KEY = "ui.version";

/**
 * Which interface the site serves.
 *
 *   field    the mobile-first field app - the default
 *   classic  the original screens, kept selectable
 *
 * The redesign is the default because it is the one the client asked for and
 * the one built for how the app is actually used. `classic` exists so a
 * rollback is a setting rather than a deploy, and so anything the redesign has
 * not covered is still reachable while it is being finished.
 */
export type UiVersion = "field" | "classic";

export const UI_VERSIONS: { value: UiVersion; label: string; description: string }[] = [
  {
    value: "field",
    label: "Field app (default)",
    description:
      "Mobile-first: larger type, bigger targets, automatic receipt capture, plain language. Built for one-handed use on site.",
  },
  {
    value: "classic",
    label: "Classic",
    description: "The original compact screens. Denser, and better suited to a desktop browser.",
  },
];

export async function getUiVersion(): Promise<UiVersion> {
  const row = await prisma.appSetting.findUnique({ where: { key: UI_VERSION_KEY } });
  // Anything unrecognised - including a value written by a newer deploy that
  // has since been rolled back - falls to the default rather than erroring.
  return row?.value === "classic" ? "classic" : "field";
}

export async function setUiVersion(version: UiVersion): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: UI_VERSION_KEY },
    update: { value: version },
    create: { key: UI_VERSION_KEY, value: version },
  });
}
