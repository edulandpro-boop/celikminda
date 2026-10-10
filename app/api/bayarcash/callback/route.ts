
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { deliverPaidPdfOrder } from "@/lib/email-delivery";
import { Bayarcash } from "bayarcash-ts-sdk";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const token = process.env.BAYARCASH_API_TOKEN;
    const secretKey = process.env.BAYARCASH_API_SECRET_KEY;

    if (!token || !secretKey) {
      console.error("Bayarcash credentials are missing.");

      return NextResponse.json(
        { error: "Payment configuration is incomplete." },
        { status: 500 }
      );
    }

    const contentType = request.headers.get("content-type") || "";
    let callbackData: Record<string, string> = {};

    if (contentType.includes("application/json")) {
      const body = await request.json();

      for (const [key, value] of Object.entries(body)) {
        callbackData[key] = String(value ?? "");
      }
    } else {
      const formData = await request.formData();

      formData.forEach((value, key) => {
        callbackData[key] = String(value);
      });
    }

    const bayarcash = new Bayarcash(token, {
      sandbox: process.env.BAYARCASH_SANDBOX === "true",
      apiVersion: "v3",
    });

    const isValid = bayarcash.verifyTransactionCallbackData(
      callbackData,
      secretKey
    );

    if (!isValid) {
      console.error("Bayarcash callback verification failed.");

      return NextResponse.json(
        { error: "Invalid callback verification." },
        { status: 400 }
      );
    }

    const orderNumber = callbackData.order_number;
    const paymentStatus = String(callbackData.status ?? "");

    if (!orderNumber) {
      return NextResponse.json(
        { error: "Missing order number." },
        { status: 400 }
      );
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from("celik_minda_orders")
      .select("*")
      .eq("order_number", orderNumber)
      .maybeSingle();

    if (orderError) {
      console.error("Order lookup failed:", orderError.message);

      return NextResponse.json(
        { error: "Unable to retrieve order." },
        { status: 500 }
      );
    }

    if (!order) {
      return NextResponse.json(
        { error: "Order not found." },
        { status: 404 }
      );
    }

    // Status 3 indicates successful payment.
    if (paymentStatus === "3") {
      if (order.payment_status === "paid") {
        return NextResponse.json({ received: true });
      }

      const { error: updateOrderError } = await supabaseAdmin
        .from("celik_minda_orders")
        .update({
          payment_status: "paid",
          order_status: "confirmed",
        })
        .eq("order_number", orderNumber);

      if (updateOrderError) {
        console.error(
          "Order payment update failed:",
          updateOrderError.message
        );

        return NextResponse.json(
          { error: "Unable to update order payment." },
          { status: 500 }
        );
      }

      const { data: delivery, error: deliveryLookupError } =
        await supabaseAdmin
          .from("celik_minda_email_deliveries")
          .select("*")
          .eq("order_number", orderNumber)
          .maybeSingle();

      if (deliveryLookupError) {
        console.error(
          "Email delivery lookup failed:",
          deliveryLookupError.message
        );

        return NextResponse.json(
          { error: "Unable to check email delivery." },
          { status: 500 }
        );
      }

      // Do not send the same order email again.
      if (delivery?.status === "sent" || delivery?.status === "sending") {
        return NextResponse.json({ received: true });
      }

      if (delivery) {
        const { error: claimError } = await supabaseAdmin
          .from("celik_minda_email_deliveries")
          .update({
            status: "sending",
            error_message: null,
          })
          .eq("order_number", orderNumber);

        if (claimError) {
          console.error("Delivery update failed:", claimError.message);

          return NextResponse.json(
            { error: "Unable to prepare email delivery." },
            { status: 500 }
          );
        }
      } else {
        const { error: createError } = await supabaseAdmin
          .from("celik_minda_email_deliveries")
          .insert({
            order_number: orderNumber,
            status: "sending",
          });

        if (createError) {
          console.error("Delivery record creation failed:", createError.message);

          return NextResponse.json(
            { error: "Unable to create email delivery record." },
            { status: 500 }
          );
        }
      }

      try {
        await deliverPaidPdfOrder(order);

        const { error: sentError } = await supabaseAdmin
          .from("celik_minda_email_deliveries")
          .update({
            status: "sent",
            error_message: null,
          })
          .eq("order_number", orderNumber);

        if (sentError) {
          console.error("Delivery status update failed:", sentError.message);

          return NextResponse.json(
            { error: "Unable to update delivery status." },
            { status: 500 }
          );
        }

        const { error: timestampError } = await supabaseAdmin
          .from("celik_minda_orders")
          .update({
            delivery_email_sent_at: new Date().toISOString(),
          })
          .eq("order_number", orderNumber);

        if (timestampError) {
          console.error(
            "Email timestamp update failed:",
            timestampError.message
          );
        }
      } catch (emailError) {
        const message =
          emailError instanceof Error
            ? emailError.message
            : "Unknown email delivery error";

        console.error("PDF email delivery failed:", message);

        await supabaseAdmin
          .from("celik_minda_email_deliveries")
          .update({
            status: "failed",
            error_message: message,
          })
          .eq("order_number", orderNumber);

        return NextResponse.json(
          { error: "Payment received, but email delivery failed." },
          { status: 500 }
        );
      }

      return NextResponse.json({ received: true });
    }

    // Status 2, 4 and 5 represent unsuccessful, cancelled or expired payments.
    if (["2", "4", "5"].includes(paymentStatus)) {
      const { error: failedUpdateError } = await supabaseAdmin
        .from("celik_minda_orders")
        .update({
          payment_status: "failed",
          order_status: "cancelled",
        })
        .eq("order_number", orderNumber)
        .neq("payment_status", "paid");

      if (failedUpdateError) {
        console.error(
          "Failed payment update error:",
          failedUpdateError.message
        );

        return NextResponse.json(
          { error: "Unable to update failed payment." },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Bayarcash callback error:", error);

    return NextResponse.json(
      { error: "Unable to process payment callback." },
      { status: 500 }
    );
  }
}
