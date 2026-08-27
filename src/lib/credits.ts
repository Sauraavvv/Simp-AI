/**
 * Plan and credit enforcement for a metered request.
 *
 * Lifted out of /api/chat's inline copy so any other metered route meters on
 * exactly the same rules. Returns a response to send back when the caller may
 * not proceed, and null when they may -- one credit lighter on the free plan.
 */

export async function chargeCredit(email: string | null): Promise<Response | null> {
  // A guest is not metered: there is no account to charge, and the guest limit
  // is enforced separately by whatever they are using.
  if (!email) return null;

  try {
    const { getDb } = await import("@/lib/mongodb");
    const db = await getDb();
    const users = db.collection("users");
    const user = await users.findOne({ email });
    if (!user) return null;

    const plan = user.plan ?? "none";
    const credits = typeof user.credits === "number" ? user.credits : 0;
    const expired =
      plan === "paid" && user.planExpiresAt && new Date(user.planExpiresAt).getTime() < Date.now();

    if (expired) {
      return Response.json(
        {
          error:
            "Your monthly Pro subscription of ₹299/month has expired. Please top up / renew your plan to continue.",
          code: "SUBSCRIPTION_EXPIRED",
        },
        { status: 402 },
      );
    }

    if (plan === "none") {
      return Response.json(
        {
          error:
            "Please activate your Free Plan (50 credits) or subscribe to Pro Monthly (₹299/month) to use this tool.",
          code: "PLAN_REQUIRED",
        },
        { status: 402 },
      );
    }

    if (plan === "free" && credits <= 0) {
      return Response.json(
        {
          error:
            "You have used all 50 free credits. Please top up by subscribing to the Pro Monthly Plan (₹299/month) to continue.",
          code: "OUT_OF_CREDITS",
        },
        { status: 402 },
      );
    }

    if (plan === "free" && credits > 0) {
      await users.updateOne({ email }, { $inc: { credits: -1 } });
    }
  } catch (err) {
    // A metering outage must not take the feature down with it -- the same
    // call in /api/chat warns and continues, and this stays consistent with it.
    console.warn("[credits] check warning:", err);
  }

  return null;
}
