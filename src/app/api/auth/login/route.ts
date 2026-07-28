import { z } from "zod";
import { authenticate, setSessionCookie } from "@/lib/auth";
import { handler, json, error } from "@/lib/api";

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const POST = handler(async (req: Request) => {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error("Invalid input", 422);
  const { email, password } = parsed.data;
  const user = await authenticate(email.toLowerCase(), password);
  if (!user) return error("Invalid email or password", 401);
  setSessionCookie(user.id);
  return json({ id: user.id, email: user.email, name: user.name });
});
