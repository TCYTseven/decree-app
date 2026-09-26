import type { DatabaseInfo, DependencyInfo } from "../core/types.js";
import { isFixturePath, type ScanContext } from "./context.js";

interface Found {
  kind: string;
  schemaFiles: Set<string>;
  models: Set<string>;
}

const PRIORITY = ["prisma", "drizzle", "typeorm", "sequelize", "mongoose", "sqlalchemy", "sqlmodel", "django", "activerecord", "gorm", "ecto", "diesel", "sql"];

const MIGRATION_DIRS = /(^|\/)(migrations|db\/migrate|prisma\/migrations|alembic\/versions|drizzle|supabase\/migrations|database\/migrations|sql\/migrations)$/;

export async function detectDatabase(ctx: ScanContext, sources: Map<string, string>, deps: DependencyInfo[]): Promise<DatabaseInfo | undefined> {
  const found = new Map<string, Found>();
  const get = (kind: string) => {
    let f = found.get(kind);
    if (!f) found.set(kind, (f = { kind, schemaFiles: new Set(), models: new Set() }));
    return f;
  };
  const depNames = new Set(deps.map((d) => d.name));

  // Prisma
  for (const f of ctx.files.filter((f) => f.ext === ".prisma" && !isFixturePath(f.path)).slice(0, 20)) {
    const text = await ctx.read(f.path);
    if (!text) continue;
    const p = get("prisma");
    p.schemaFiles.add(f.path);
    for (const m of text.matchAll(/^\s*model\s+(\w+)\s*\{/gm)) p.models.add(m[1]!);
  }

  for (const [file, text] of sources) {
    // Drizzle
    if (/\b(pgTable|mysqlTable|sqliteTable)\s*\(/.test(text)) {
      const d = get("drizzle");
      d.schemaFiles.add(file);
      for (const m of text.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"`](\w+)['"`]/g)) d.models.add(m[1]!);
    }
    // TypeORM
    if (/@Entity\(/.test(text) && /typeorm/.test(text)) {
      const t = get("typeorm");
      t.schemaFiles.add(file);
      for (const m of text.matchAll(/@Entity\([^)]*\)\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)/g)) t.models.add(m[1]!);
    }
    // Sequelize
    if (/sequelize/.test(text) && (/\.define\(\s*['"]/.test(text) || /extends\s+Model\b/.test(text))) {
      const s = get("sequelize");
      s.schemaFiles.add(file);
      for (const m of text.matchAll(/\.define\(\s*['"](\w+)['"]/g)) s.models.add(m[1]!);
      for (const m of text.matchAll(/class\s+(\w+)\s+extends\s+Model\b/g)) s.models.add(m[1]!);
    }
    // Mongoose
    if (/mongoose/.test(text) && /\bmodel\s*(<[^>]*>)?\(\s*['"]/.test(text)) {
      const mg = get("mongoose");
      mg.schemaFiles.add(file);
      for (const m of text.matchAll(/\bmodel\s*(?:<[^>]*>)?\(\s*['"](\w+)['"]/g)) mg.models.add(m[1]!);
    }
    if (file.endsWith(".py")) {
      // SQLModel
      if (/table\s*=\s*True/.test(text)) {
        const s = get("sqlmodel");
        for (const m of text.matchAll(/^class\s+(\w+)\s*\([^)]*table\s*=\s*True[^)]*\)/gm)) {
          s.models.add(m[1]!);
          s.schemaFiles.add(file);
        }
      }
      // SQLAlchemy
      if (/sqlalchemy/.test(text) || /__tablename__/.test(text)) {
        const s = get("sqlalchemy");
        for (const m of text.matchAll(/^class\s+(\w+)\s*\(([^)]*)\)\s*:/gm)) {
          if (/\b(Base|DeclarativeBase|Model|db\.Model)\b/.test(m[2]!) && !/models\.Model|BaseModel|Schema/.test(m[2]!)) {
            if (m[1] === "Base") continue;
            s.models.add(m[1]!);
            s.schemaFiles.add(file);
          }
        }
      }
      // Django
      if (/models\.Model\b/.test(text)) {
        const d = get("django");
        for (const m of text.matchAll(/^class\s+(\w+)\s*\([^)]*models\.Model[^)]*\)/gm)) {
          d.models.add(m[1]!);
          d.schemaFiles.add(file);
        }
      }
    }
    // ActiveRecord
    if (file.endsWith(".rb") && /<\s*(ApplicationRecord|ActiveRecord::Base)/.test(text)) {
      const a = get("activerecord");
      a.schemaFiles.add(file);
      for (const m of text.matchAll(/class\s+(\w+)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)/g)) if (m[1] !== "ApplicationRecord") a.models.add(m[1]!);
    }
    // GORM
    if (file.endsWith(".go") && /gorm\.Model|gorm:"/.test(text)) {
      const g = get("gorm");
      g.schemaFiles.add(file);
      for (const m of text.matchAll(/type\s+(\w+)\s+struct\s*\{[^}]*?(gorm\.Model|gorm:")/g)) g.models.add(m[1]!);
    }
    // Ecto
    if (/\.exs?$/.test(file) && /use Ecto\.Schema/.test(text)) {
      const e = get("ecto");
      e.schemaFiles.add(file);
      for (const m of text.matchAll(/schema\s+"(\w+)"/g)) e.models.add(m[1]!);
    }
  }
  // Django needs the dep or manage.py to count; sqlalchemy empty hits are dropped below.
  if (found.has("django") && !depNames.has("django") && !ctx.has("manage.py")) found.delete("django");

  // Rails schema
  const railsSchema = ctx.first("db/schema.rb");
  if (railsSchema) {
    const text = await ctx.read(railsSchema);
    if (text) {
      const a = get("activerecord");
      a.schemaFiles.add(railsSchema);
      for (const m of text.matchAll(/create_table\s+"(\w+)"/g)) a.models.add(m[1]!);
    }
  }

  // Raw SQL
  const sqlFiles = ctx.files.filter((f) => f.ext === ".sql" && f.size < 1024 * 1024 && !isFixturePath(f.path));
  if (sqlFiles.length) {
    const s = get("sql");
    for (const f of sqlFiles.slice(0, 60)) {
      s.schemaFiles.add(f.path);
      const text = await ctx.read(f.path);
      if (!text) continue;
      for (const m of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?[`"\[]?(?:\w+[`"\]]?\.[`"\[]?)?(\w+)/gi)) s.models.add(m[1]!);
    }
  }

  const kinds = [...found.values()].filter((f) => f.models.size || f.schemaFiles.size);
  if (!kinds.length) {
    // dependency-only signals
    const depKind =
      (depNames.has("prisma") || depNames.has("@prisma/client") ? "prisma" : undefined) ??
      (depNames.has("drizzle-orm") ? "drizzle" : undefined) ??
      (depNames.has("typeorm") ? "typeorm" : undefined) ??
      (depNames.has("sequelize") ? "sequelize" : undefined) ??
      (depNames.has("mongoose") ? "mongoose" : undefined) ??
      (depNames.has("sqlalchemy") ? "sqlalchemy" : undefined) ??
      (depNames.has("gorm.io/gorm") ? "gorm" : undefined);
    if (!depKind) return undefined;
    kinds.push({ kind: depKind, schemaFiles: new Set(), models: new Set() });
  }
  kinds.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
  const primary = kinds[0]!;
  // migration directories are schema context for any kind
  const migrationDirs = ctx.walk.dirs.filter((d) => MIGRATION_DIRS.test(d) && !isFixturePath(d + "/")).slice(0, 5);
  const schemaFiles = [...primary.schemaFiles].sort().slice(0, 30);
  for (const d of migrationDirs) if (!schemaFiles.some((s) => s.startsWith(d + "/"))) schemaFiles.push(d + "/");
  return { kind: primary.kind, schemaFiles, models: [...primary.models].slice(0, 100) };
}
