// Builds the Download PDF cost report

import PDFDocument from "pdfkit";
import { aggregateCost, dailySeries } from "./costHistory.js";
import { ROOMS } from "./schema.js";

const PERIOD_LABEL = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", annual: "Annual" };

export function streamCostReportPdf(period, res) {
  const agg = aggregateCost(period);
  const series = dailySeries(period);

  const doc = new PDFDocument({ margin: 50, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="soms-cost-report-${period}-${new Date().toISOString().slice(0, 10)}.pdf"`);
  doc.pipe(res);

  // ---- header ----
  doc.fontSize(20).fillColor("#0a0f1a").text("SOMS — Smart Office Management System", { continued: false });
  doc.fontSize(14).fillColor("#333").text(`${PERIOD_LABEL[period] || period} Electricity Cost Report`);
  doc.fontSize(9).fillColor("#777").text(`Generated ${new Date().toLocaleString()} · rate applied: ${agg.kwhRate.toFixed(4)}/kWh`);
  doc.moveDown(1);

  // ---- summary ----
  doc.fontSize(12).fillColor("#000").text("Summary", { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor("#111");
  doc.text(`Total estimated cost: ${agg.totalCost.toFixed(2)}`);
  doc.text(`Total energy used: ${agg.totalKwh.toFixed(3)} kWh`);
  doc.text(`Rooms covered: ${ROOMS.length}`);
  if (agg.note) doc.fillColor("#a15c00").text(`Note: ${agg.note}`);
  doc.moveDown(1);

  // ---- per room table ----
  doc.fillColor("#000").fontSize(12).text("Spend by Room", { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10);
  agg.perRoom.forEach((r) => {
    const share = agg.totalCost > 0 ? ((r.cost / agg.totalCost) * 100).toFixed(1) : "0.0";
    doc.fillColor("#111").text(`${r.name.padEnd(24, " ")}  ${r.cost.toFixed(2).padStart(10, " ")}   (${share}%)   ${r.kwh.toFixed(2)} kWh`);
  });
  doc.moveDown(1);

  // ---- per device type table ----
  doc.fillColor("#000").fontSize(12).text("Spend by Device Type", { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10);
  agg.perType.forEach((t) => {
    doc.fillColor("#111").text(`${t.type.padEnd(12, " ")}  ${t.cost.toFixed(2).padStart(10, " ")}   ${t.kwh.toFixed(2)} kWh`);
  });
  doc.moveDown(1);

  // ---- daily breakdown ----
  if (series.length) {
    doc.fillColor("#000").fontSize(12).text("Daily Breakdown", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(9);
    series.forEach((d) => {
      doc.fillColor("#111").text(`${d.day}    cost ${d.cost.toFixed(2)}    ${d.kwh.toFixed(2)} kWh`);
    });
  }

  doc.moveDown(1.5);
  doc.fontSize(8).fillColor("#888").text("This report is a rule-based estimate derived from measured device on-time × rated wattage × your configured electricity rate. It is not a substitute for a utility bill.", { width: 480 });

  doc.end();
}
