import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";
import { MAX_RADIUS_METRES } from "@/lib/geo";

export const GET = handler(async () => {
  const userId = requireUserId();
  const jobs = await prisma.job.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return json({ jobs });
});

const Body = z.object({
  number: z.string().min(1).max(60),
  name: z.string().max(160).optional(),
  // Where the site is, so the phone can attach it by arriving. Optional
  // throughout: a job with no coordinates is still a job, it simply never
  // matches automatically.
  address: z.string().max(240).optional(),
  latitude: z.number().finite().min(-90).max(90).optional(),
  longitude: z.number().finite().min(-180).max(180).optional(),
  radiusMetres: z.number().int().positive().max(MAX_RADIUS_METRES).optional(),
})
  // A lone coordinate is a typo, not half an answer, and stored on its own it
  // would sit in the table looking like data forever.
  .refine((b) => (b.latitude === undefined) === (b.longitude === undefined), {
    message: "Give both a latitude and a longitude, or neither",
  });

export const POST = handler(async (req: Request) => {
  const userId = requireUserId();
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "A job number is required", 422);
  const { number, name, address, latitude, longitude, radiusMetres } = parsed.data;

  // Only what was actually sent is written, so updating a job's name does not
  // wipe the coordinates someone set for it.
  const update: Record<string, unknown> = {};
  if (name !== undefined) update.name = name;
  if (address !== undefined) update.address = address;
  if (latitude !== undefined) update.latitude = latitude;
  if (longitude !== undefined) update.longitude = longitude;
  if (radiusMetres !== undefined) update.radiusMetres = radiusMetres;

  const job = await prisma.job.upsert({
    where: { userId_number: { userId, number } },
    update,
    create: {
      userId,
      number,
      name: name ?? null,
      address: address ?? null,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      radiusMetres: radiusMetres ?? null,
    },
  });
  return json({ job }, 201);
});
