import assert from "node:assert/strict";
import { after, test } from "node:test";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import {
  foundationProps,
  foundationService,
} from "./foundation-ui.test-support.mjs";
import { textService } from "./text-ui.test-support.mjs";
import {
  assetControllerFixture,
  content,
} from "./asset-controller.test-support.mjs";
import { sourceUiDefinition } from "./source-ui.test-support.mjs";
const definition = await sourceUiDefinition();
after(async () => browser.happyDOM.close());

for (const origin of ["creative", "novel"]) {
  test(`${origin} projects open the adopted description in an accessible concept workspace, preserving the draft and saved input`, async () => {
    const foundation = foundationService(),
      created = foundation.seed(origin);
    const projectId = created.project.projectId;
    const plan = foundation.proposal(
      projectId,
      "原创人物，先确认设定，再探索画面。",
    );
    foundation.foundations.get(projectId).confirmedProposal = {
      revision: plan.revision,
      digest: plan.contentDigest,
    };
    foundation.foundations.get(projectId).revision += 1;
    const text = textService();
    text.metadata.records.set(
      projectId,
      foundation.metadata.records.get(projectId),
    );
    const assets = assetControllerFixture({
      briefDigest: created.brief.contentDigest,
    });
    const navigation = [],
      calls = [];
    const props = (stage) => {
      const value = foundationProps();
      return {
        ...value,
        data: {
          ...value.data,
          hostPresentation: {
            surface: "workbench",
            context: { projectId, stage },
          },
        },
      };
    };
    const services = {
      async invoke(action, input, options) {
        calls.push(action);
        if (action === "crewon.plugin-navigation.open-page") {
          navigation.push(structuredClone(input));
          f.instance.update(props(input.context.stage));
          return {
            version: "crewon.plugin-ui-navigation.v1",
            pageId: "original-project",
          };
        }
        const method = action.split(".").at(-1);
        if (action.startsWith("crewon.project-assets.v2."))
          return assets.client[method](input, options);
        if (action.startsWith("crewon.project-asset-recovery.v2."))
          return assets.recovery[method](input, options);
        if (action.startsWith("crewon.project-foundation."))
          return foundation.services.invoke(action, input, options);
        return text.services.invoke(action, input, options);
      },
    };
    let f = fixture(definition, { props: props("characters"), services });
    try {
      await settle();
      assert.ok(
        f.container.querySelector('[aria-label="共享资产"]'),
        f.container.textContent.slice(-1800),
      );
      await f.click(f.button("新建角色"));
      for (const [label, value] of [
        ["资产名称", content.name],
        ["资产设定", content.setting],
        ["资产画面描述", content.visualPrompt],
      ]) {
        await f.input(
          f.container.querySelector(
            `input[aria-label="${label}"],textarea[aria-label="${label}"]`,
          ),
          value,
        );
      }
      await f.click(f.button("保存设定候选"));
      await f.click(f.button("选用这版设定"));
      await f.click(f.button("用这版设定探索概念图"));
      assert.equal(
        f.container.querySelector("#concept-prompt")?.value,
        content.visualPrompt,
        "the action must display the copied description rather than the Foundation plan",
      );
      assert.equal(navigation.at(-1).context.stage, "concepts");
      assert.equal(text.metadata.methodCalls("createConcept").length, 0);
      await f.input(
        f.container.querySelector("#concept-prompt"),
        content.visualPrompt + " 保留修改。",
      );
      await f.click(
        f.container.querySelector('[data-project-page="characters"]'),
      );
      await f.click(
        f.container.querySelector('[data-project-page="concepts"]'),
      );
      assert.equal(
        f.container.querySelector("#concept-prompt").value,
        content.visualPrompt + " 保留修改。",
      );
      await f.click(f.button("保存概念输入"));
      assert.equal(text.metadata.methodCalls("createConcept").length, 1);
      assert.equal(
        text.metadata.methodCalls("createConcept")[0].input.projectId,
        projectId,
      );
      await f.dispose();
      f = fixture(definition, { props: props("concepts"), services });
      await settle();
      await f.click(f.container.querySelector(".concept-panel .version-card"));
      assert.match(f.container.textContent, /保留修改/);
      assert.equal(text.metadata.methodCalls("createConcept").length, 1);
      assert.equal(
        calls.some((action) =>
          /project-generations\.v1\.submit|crewon\.tasks\.v2\.submit/.test(
            action,
          ),
        ),
        false,
      );
    } finally {
      await f.dispose();
    }
  });
}
