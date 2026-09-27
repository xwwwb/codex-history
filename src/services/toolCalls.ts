import { parse, type AnyNode } from "acorn";
import type { ToolCallSummary } from "../types";

const shellTools = new Set(["exec_command", "shell", "shell_command"]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function decode(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function baseName(name: string) {
  return name.split(".").at(-1) ?? name;
}

function quoteArgument(value: string) {
  return /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function shellCommand(input: unknown): string | undefined {
  const args = object(input);
  const command = args.cmd ?? args.command ?? (typeof input === "string" ? input : undefined);
  if (typeof command === "string") return command;
  if (!Array.isArray(command) || !command.every((part) => typeof part === "string"))
    return undefined;

  // 常见 shell 参数数组中，-c 后的字符串就是完整脚本。
  if (
    command.length === 3 &&
    /(?:^|\/)(?:sh|bash|zsh|dash|ksh)$/.test(command[0]) &&
    /^-[a-z]*c[a-z]*$/.test(command[1])
  )
    return command[2];
  return command.map(quoteArgument).join(" ");
}

// 只读取静态字面量，不执行历史记录中的 JavaScript。
function literal(node: AnyNode | null | undefined): unknown {
  if (!node) return undefined;
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && !node.expressions.length)
    return node.quasis[0]?.value.cooked;
  if (node.type === "ArrayExpression") {
    const values = node.elements.map(literal);
    return values.some((value) => value === undefined) ? undefined : values;
  }
  if (node.type === "ObjectExpression") {
    const result: Record<string, unknown> = Object.create(null);
    for (const property of node.properties) {
      // 展开属性可能覆盖前面的命令，无法确定时保留原始表达式。
      if (property.type !== "Property") return undefined;
      const key =
        !property.computed && property.key.type === "Identifier"
          ? property.key.name
          : literal(property.key);
      if (typeof key !== "string") return undefined;
      result[key] = property.kind === "init" ? literal(property.value) : undefined;
    }
    return result;
  }
  return undefined;
}

function memberName(node: AnyNode): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "ChainExpression") return memberName(node.expression);
  if (node.type !== "MemberExpression") return undefined;
  const parent = memberName(node.object);
  const key =
    !node.computed && node.property.type === "Identifier"
      ? node.property.name
      : literal(node.property);
  return parent && typeof key === "string" ? `${parent}.${key}` : undefined;
}

function isNode(value: unknown): value is AnyNode {
  return typeof object(value).type === "string";
}

function callsFromSource(source: string): ToolCallSummary[] {
  const root = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  });
  const calls: Array<{ start: number; summary: ToolCallSummary }> = [];

  function visit(node: AnyNode) {
    if (node.type === "CallExpression") {
      const path = memberName(node.callee);
      if (path?.startsWith("tools.") || path?.startsWith("functions.")) {
        const name = path.slice(path.indexOf(".") + 1);
        const summary: ToolCallSummary = { name };
        if (shellTools.has(baseName(name))) {
          summary.command = shellCommand(literal(node.arguments[0]));
          if (summary.command === undefined)
            summary.expression = source.slice(node.start, node.end);
        }
        calls.push({ start: node.start, summary });
      }
    }
    for (const value of Object.values(node)) {
      if (isNode(value)) visit(value);
      else if (Array.isArray(value)) value.filter(isNode).forEach(visit);
    }
  }

  visit(root);
  return calls.sort((a, b) => a.start - b.start).map((call) => call.summary);
}

export function summarizeToolCalls(name: string, input: unknown): ToolCallSummary[] {
  const args = decode(input);
  if (baseName(name) === "exec") {
    const data = object(args);
    const source = typeof args === "string" ? args : (data.code ?? data.script ?? data.input);
    if (typeof source === "string") {
      try {
        const calls = callsFromSource(source);
        if (calls.length) return calls;
      } catch {
        // 未完成或无法解析的代码仍显示外层工具名，完整输入留在详细信息中。
      }
    }
  }
  const summary: ToolCallSummary = { name };
  if (shellTools.has(baseName(name))) summary.command = shellCommand(args);
  return [summary];
}
