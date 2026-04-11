import type { Express } from "express";

import { insertCalculationRuleSchema } from "@shared/schema";

import { PermissionLevel } from "../admin-auth";
import { requireAdmin } from "../middleware/requireAdmin";
import { reloadCalculationRulesFromDb } from "../services/calculationRulesLoader";
import { storage } from "../storage";

import { handleRouteError, parseNumericId } from "./route-helpers";

export function registerCalculationRulesRoutes(app: Express): void {
  app.get(
    "/api/calculation-rules",
    requireAdmin(PermissionLevel.SUPER),
    async (_req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const rules = await storage.getCalculationRules();
        return res.json(rules);
      } catch (err) {
        return handleRouteError(err, res);
      }
    },
  );

  app.post(
    "/api/calculation-rules",
    requireAdmin(PermissionLevel.SUPER),
    async (req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const validatedData = insertCalculationRuleSchema.parse(req.body);
        const created = await storage.createCalculationRule(validatedData);

        await reloadCalculationRulesFromDb();

        return res.status(201).json(created);
      } catch (err) {
        return handleRouteError(err, res);
      }
    },
  );

  app.put(
    "/api/calculation-rules/:id",
    requireAdmin(PermissionLevel.SUPER),
    async (req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const id = parseNumericId(req.params.id);
        if (id === null) {
          return res.status(400).json({ message: "Invalid ID" });
        }

        const validatedData = insertCalculationRuleSchema.partial().parse(req.body);
        const updated = await storage.updateCalculationRule(id, validatedData);
        if (!updated) {
          return res.status(404).json({ message: "Calculation rule not found" });
        }

        await reloadCalculationRulesFromDb();

        return res.json(updated);
      } catch (err) {
        return handleRouteError(err, res);
      }
    },
  );

  app.delete(
    "/api/calculation-rules/:id",
    requireAdmin(PermissionLevel.SUPER),
    async (req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const id = parseNumericId(req.params.id);
        if (id === null) {
          return res.status(400).json({ message: "Invalid ID" });
        }

        const deleted = await storage.deleteCalculationRule(id);
        if (!deleted) {
          return res.status(404).json({ message: "Calculation rule not found" });
        }

        await reloadCalculationRulesFromDb();

        return res.status(204).end();
      } catch (err) {
        return handleRouteError(err, res);
      }
    },
  );
}
