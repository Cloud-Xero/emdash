import { it, expect, beforeEach, afterEach } from "vitest";

import { PluginStorageRepository } from "../../../../src/database/repositories/plugin-storage.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";

type ScoreDoc = { score: number; label: string };
type NullableScoreDoc = { score?: number | null; label: string };

async function collectAllPages<T>(
	repo: PluginStorageRepository<T>,
	options: { orderBy?: Record<string, "asc" | "desc">; limit?: number } = {},
): Promise<Array<{ id: string; data: T }>> {
	const items: Array<{ id: string; data: T }> = [];
	let cursor: string | undefined;
	for (let page = 0; page < 20; page++) {
		const result = await repo.query({ ...options, cursor });
		items.push(...result.items);
		if (!result.hasMore) break;
		cursor = result.cursor;
	}
	return items;
}

describeEachDialect("PluginStorageRepository", (dialect) => {
	let ctx: DialectTestContext;
	let repo: PluginStorageRepository<ScoreDoc>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new PluginStorageRepository(ctx.db, "test-plugin", "scores", ["score"]);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function seedScores() {
		const values = [10, 20, 30, 40, 50];
		for (const score of values) {
			await repo.put(`score-${score}`, { score, label: `item-${score}` });
		}
		return values;
	}

	it("paginates without orderBy and skips deleted rows", async () => {
		await seedScores();

		const page1 = await repo.query({ limit: 2 });
		expect(page1.items).toHaveLength(2);
		expect(page1.hasMore).toBe(true);

		const anchorId = page1.items[1].id;
		await repo.delete(anchorId);

		const page2 = await repo.query({ limit: 2, cursor: page1.cursor });
		// The deleted anchor should not reappear and the page should continue.
		expect(page2.items.map((i) => i.id)).not.toContain(anchorId);
		expect(page2.items).toHaveLength(2);
	});

	it("pages through ordered results and resumes after deleting the anchor row (desc)", async () => {
		await seedScores();

		const page1 = await repo.query({ orderBy: { score: "desc" }, limit: 2 });
		expect(page1.items.map((i) => i.id)).toEqual(["score-50", "score-40"]);
		expect(page1.hasMore).toBe(true);

		await repo.delete("score-40");

		const page2 = await repo.query({
			orderBy: { score: "desc" },
			limit: 2,
			cursor: page1.cursor,
		});
		expect(page2.items.map((i) => i.id)).toEqual(["score-30", "score-20"]);
		expect(page2.hasMore).toBe(true);
	});

	it("pages through ordered results and resumes after deleting the anchor row (asc)", async () => {
		await seedScores();

		const page1 = await repo.query({ orderBy: { score: "asc" }, limit: 2 });
		expect(page1.items.map((i) => i.id)).toEqual(["score-10", "score-20"]);
		expect(page1.hasMore).toBe(true);

		await repo.delete("score-20");

		const page2 = await repo.query({
			orderBy: { score: "asc" },
			limit: 2,
			cursor: page1.cursor,
		});
		expect(page2.items.map((i) => i.id)).toEqual(["score-30", "score-40"]);
		expect(page2.hasMore).toBe(true);
	});

	it("walks all pages without duplication while rows are deleted", async () => {
		await seedScores();

		const collected: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 5; page++) {
			const result = await repo.query({
				orderBy: { score: "asc" },
				limit: 2,
				cursor,
			});
			collected.push(...result.items.map((i) => i.id));
			// Delete the anchor of the page we just consumed before moving on.
			const lastItem = result.items.at(-1);
			if (lastItem) {
				await repo.delete(lastItem.id);
			}
			if (!result.hasMore) break;
			cursor = result.cursor;
		}

		// We expect exactly the set of all five rows, none duplicated,
		// even though every page's anchor was deleted after it was read.
		expect(collected).toHaveLength(5);
		expect(new Set(collected).size).toBe(5);
		expect(collected.toSorted()).toEqual([
			"score-10",
			"score-20",
			"score-30",
			"score-40",
			"score-50",
		]);
	});

	it("resumes after a living anchor for ordered ascending pagination", async () => {
		await seedScores();

		const page1 = await repo.query({ orderBy: { score: "asc" }, limit: 2 });
		const page2 = await repo.query({
			orderBy: { score: "asc" },
			limit: 2,
			cursor: page1.cursor,
		});
		expect(page2.items.map((i) => i.id)).toEqual(["score-30", "score-40"]);
		expect(page2.hasMore).toBe(true);
	});

	it("breaks ties by id and resumes after deleting a tied anchor", async () => {
		await repo.put("tie-a", { score: 5, label: "a" });
		await repo.put("tie-b", { score: 5, label: "b" });
		await repo.put("tie-c", { score: 5, label: "c" });
		await repo.put("tie-d", { score: 6, label: "d" });

		const page1 = await repo.query({ orderBy: { score: "asc" }, limit: 2 });
		expect(page1.items.map((i) => i.id)).toEqual(["tie-a", "tie-b"]);

		await repo.delete("tie-b");

		const page2 = await repo.query({
			orderBy: { score: "asc" },
			limit: 2,
			cursor: page1.cursor,
		});
		expect(page2.items.map((i) => i.id)).toEqual(["tie-c", "tie-d"]);
	});

	describe("null/missing ordered field boundaries", () => {
		let nullRepo: PluginStorageRepository<NullableScoreDoc>;

		beforeEach(() => {
			nullRepo = new PluginStorageRepository(ctx.db, "test-plugin", "nullable-scores", ["score"]);
		});

		async function seedNullsAndMissing() {
			await nullRepo.put("explicit-null", { score: null, label: "explicit-null" });
			await nullRepo.put("value-10", { score: 10, label: "value-10" });
			await nullRepo.put("value-20", { score: 20, label: "value-20" });
			await nullRepo.put("missing", { label: "missing" });
		}

		it("orders explicit null, missing, and non-null values consistently with the cursor", async () => {
			await seedNullsAndMissing();

			const all = await collectAllPages(nullRepo, {
				orderBy: { score: "asc" },
				limit: 1,
			});
			const ids = all.map((i) => i.id);

			// Postgres orders explicit JSON null with non-null values (jsonb null
			// is a scalar), while missing keys get the higher null rank and come
			// last. SQLite treats explicit null and missing identically, so all
			// SQL-NULL rows sort after the non-null values by id.
			if (dialect === "postgres") {
				expect(ids).toEqual(["explicit-null", "value-10", "value-20", "missing"]);
			} else {
				expect(ids).toEqual(["value-10", "value-20", "explicit-null", "missing"]);
			}
		});

		it("walks explicit-null/missing/value rows without duplication while deleting anchors", async () => {
			await seedNullsAndMissing();

			const collected: string[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < 10; page++) {
				const result = await nullRepo.query({
					orderBy: { score: "asc" },
					limit: 1,
					cursor,
				});
				collected.push(...result.items.map((i) => i.id));
				const lastItem = result.items.at(-1);
				if (lastItem) {
					await nullRepo.delete(lastItem.id);
				}
				if (!result.hasMore) break;
				cursor = result.cursor;
			}

			expect(collected).toHaveLength(4);
			expect(new Set(collected).size).toBe(4);
			expect(collected.toSorted()).toEqual(["explicit-null", "missing", "value-10", "value-20"]);
		});

		it("pages over desc order without conflating null and missing", async () => {
			await seedNullsAndMissing();

			const all = await collectAllPages(nullRepo, {
				orderBy: { score: "desc" },
				limit: 1,
			});
			const ids = all.map((i) => i.id);

			if (dialect === "postgres") {
				// Desc: missing first (highest null rank), then values high-to-low,
				// then explicit jsonb null last.
				expect(ids).toEqual(["missing", "value-20", "value-10", "explicit-null"]);
			} else {
				// SQLite groups both null-ish rows with the smaller id first.
				expect(ids).toEqual(["missing", "explicit-null", "value-20", "value-10"]);
			}
		});
	});
});
