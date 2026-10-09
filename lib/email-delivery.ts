
import { getSupabaseAdmin } from "@/lib/supabase-admin";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] ?? char));
}

const DRIVE_SET_A =
  "https://drive.google.com/drive/folders/1ValEsVEyMdq171PrIvYo3H5xRE_LlxZe";

const DRIVE_SET_B =
  "https://drive.google.com/drive/folders/17zSebHpDCut2Kr-njtEoNupU4i-NzhOB";

type PaidOrder = {
  id: string;
  order_number: string;
  customer_name: string;
  email: string;
};

export async function deliverPaidPdfOrder(order: PaidOrder) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    throw new Error("Missing RESEND_API_KEY or EMAIL_FROM.");
  }

  const supabase = getSupabaseAdmin();

  const { data: items, error } = await supabase
    .from("celik_minda_order_items")
    .select("product_id, product_name, format")
    .eq("order_id", order.id);

  if (error) throw new Error(`Order items: ${error.message}`);
  if (!items?.length) throw new Error("No order items found.");

  const productIds = [
    ...new Set(items.map((item) => item.product_id).filter(Boolean)),
  ];

  const { data: products, error: productError } = await supabase
    .from("celik_minda_products")
    .select("id, sku")
    .in("id", productIds);

  if (productError) throw new Error(productError.message);

  const skuById = new Map(
    (products || []).map((product) => [
      product.id,
      String(product.sku),
    ]),
  );

  const skus = items.map(
    (item) => skuById.get(item.product_id) || "",
  );

  const isPdf = (index: number) =>
    String(items[index].format || "").toLowerCase() === "pdf" ||
    skus[index].endsWith("-PDF");

  const isHardcopy = items.some(
    (item, index) => !isPdf(index),
  );

  const links: { label: string; url: string }[] = [];

  for (let i = 0; i < items.length; i++) {
    if (!isPdf(i)) continue;

    const sku = skus[i];

    if (sku === "CMA-PDF") {
      links.push({ label: "Set A — 5 Tahun", url: DRIVE_SET_A });
    } else if (sku === "CMB-PDF") {
      links.push({ label: "Set B — 6 Tahun", url: DRIVE_SET_B });
    } else if (sku === "CMAB-PDF") {
      links.push({ label: "Set A — 5 Tahun", url: DRIVE_SET_A });
      links.push({ label: "Set B — 6 Tahun", url: DRIVE_SET_B });
    }
  }

  if (!isHardcopy && !links.length) {
    throw new Error("No matching PDF links configured.");
  }

  const name = escapeHtml(order.customer_name || "Pelanggan");
  const orderNo = escapeHtml(order.order_number);

  const content = isHardcopy
    ? `<p>Pesanan hardcopy anda telah disahkan. Bahan akan diproses untuk penghantaran ke alamat yang diberikan semasa checkout.</p>`
    : "";

  const linkHtml = links.length
    ? `<h3>Bahan PDF anda</h3><ul>${links
        .map(
          (link) =>
            `<li><a href="${link.url}">Muat turun ${escapeHtml(link.label)}</a></li>`,
        )
        .join("")}</ul><p>Pautan Google Drive tertakluk pada tetapan perkongsian folder.</p>`
    : "";

  const linkText = links
    .map((link) => `${link.label}: ${link.url}`)
    .join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [order.email],
      subject: `Pesanan Celik Minda Disahkan — ${order.order_number}`,
      text: [
        `Assalamualaikum ${order.customer_name || ""},`,
        "",
        `Bayaran untuk pesanan ${order.order_number} telah disahkan.`,
        isHardcopy
          ? "Pesanan hardcopy anda akan diproses untuk penghantaran ke alamat yang diberikan semasa checkout."
          : "",
        linkText,
        "",
        "Terima kasih kerana membeli bahan Ulang Kaji Celik Minda.",
      ]
        .filter(Boolean)
        .join("\n"),
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.7;color:#173b28;max-width:620px;margin:auto">
          <h2 style="color:#14532d">Pesanan Celik Minda Berjaya</h2>
          <p>Assalamualaikum ${name},</p>
          <p>Bayaran untuk pesanan <strong>${orderNo}</strong> telah disahkan.</p>
          ${content}
          ${linkHtml}
          <p>Terima kasih kerana membeli bahan Ulang Kaji Celik Minda.</p>
          <p><strong>Celik Minda PASTI</strong></p>
        </div>
      `,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Resend failed (${response.status}): ${message.slice(0, 500)}`,
    );
  }

  return { sent: true as const };
}
