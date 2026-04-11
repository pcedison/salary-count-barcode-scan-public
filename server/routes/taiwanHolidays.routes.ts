import type { Express } from "express";
import { z } from "zod";

import { insertTaiwanHolidaySchema } from "@shared/schema";

import { PermissionLevel } from "../admin-auth";
import { requireAdmin } from "../middleware/requireAdmin";
import { storage } from "../storage";

import { handleRouteError } from "./route-helpers";

const importBodySchema = z.object({
  holidays: z.array(insertTaiwanHolidaySchema).min(1, "At least one holiday is required"),
});

export function registerTaiwanHolidaysRoutes(app: Express): void {
  app.get(
    "/api/taiwan-holidays",
    requireAdmin(PermissionLevel.SUPER),
    async (req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");

        const yearParam = req.query.year;
        let year: number | undefined;

        if (yearParam !== undefined) {
          year = Number.parseInt(String(yearParam), 10);
          if (Number.isNaN(year)) {
            return res.status(400).json({ message: "Invalid year parameter" });
          }
        }

        const holidays = await storage.getTaiwanHolidays(year);
        return res.json(holidays);
      } catch (err) {
        return handleRouteError(err, res);
      }
    },
  );

  app.post(
    "/api/taiwan-holidays/import",
    requireAdmin(PermissionLevel.SUPER),
    async (req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const { holidays } = importBodySchema.parse(req.body);
        const result = await storage.importTaiwanHolidays(holidays);
        return res.status(200).json(result);
      } catch (err) {
        return handleRouteError(err, res);
      }
    },
  );

  app.delete(
    "/api/taiwan-holidays/:id",
    requireAdmin(PermissionLevel.SUPER),
    async (req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const { id } = req.params;

        if (!id || id.trim() === "") {
          return res.status(400).json({ message: "Invalid ID" });
        }

        const deleted = await storage.deleteTaiwanHoliday(id);
        if (!deleted) {
          return res.status(404).json({ message: "Taiwan holiday not found" });
        }

        return res.status(204).end();
      } catch (err) {
        return handleRouteError(err, res);
      }
    },
  );
}
