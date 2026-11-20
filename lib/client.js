/**
 * Browser half of dsh-ask-alert.
 *
 * The Host half exports a Config schema whose fields are volatile, so the
 * profile keeps the user's choices in its patch file. This half turns those
 * fields into a compact form on the plugin's own page in the plugin manager:
 * one line per field (label on the left, control on the right), grouped by
 * intent, and saving as the user settles each control: switches and resets write
 * at once, text and number fields write on blur, so the page has no save button.
 *
 * The rows are drawn here instead of through `SettingsValueField`: that control
 * stacks label, input and hint into three lines and separates neighbours with a
 * rule, which turned twelve settings into a long column. The controls below
 * keep the same tokens so the form still looks like the rest of the app.
 */

window.__ModuleLoader__.load({
	id: 'dsh-ask-alert',
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		const h = React.createElement;

		/** Profile entry id of the Host half; the settings form is keyed by it. */
		const NS = 'dsh-ask-alert';

		/** Copy the form and its controls render. */
		const LABELS = {
			title: '提醒卡片',
			summary: '提问、审批或一轮任务结束时弹出置顶卡片，并闪任务栏、响提示音。',
			unavailable: '该插件当前未运行，暂时无法配置。',
			readOnly: '本部署的设置为只读。',
			statusSaved: '已保存',
			statusSaving: '保存中…',
			statusFailed: '保存失败，改一下再试',
			statusInvalid: '值不合法，未保存',
			overridden: '已覆盖',
			reset: '恢复默认',
			invalidText: '请填写文本；留空表示使用默认值。',
			invalidNumber: '请填数字；留空表示使用默认值。',
		};

		/**
		 * The shipped defaults, mirroring `DEFAULTS` in `index.js`.
		 *
		 * The form only shows its "overridden / reset" tail when a field would
		 * really behave differently from a fresh install. Without this table the
		 * tail would appear for any explicit entry in the profile patch — flipping a
		 * switch off and back on leaves one behind even though the value equals the
		 * default again, and users read that badge as "something changed".
		 */
		const DEFAULTS = {
			askTitle: 'DSH · 有个问题等你回答',
			askBody: '助手在等你回复，请切回 DeepSeek Harness。',
			approveTitle: 'DSH · 需要你确认',
			approveBody: '有一个操作正在等你批准或拒绝。',
			doneTitle: 'DSH · 任务完成',
			doneBody: '这一轮任务已结束，可以回来查看结果了。',
			repeatSeconds: 20,
			maxAlerts: 5,
			onApproval: true,
			onDone: true,
			showProject: true,
			sound: true,
		};

		/**
		 * Whether the staged text still matches the shipped default, in which case
		 * the field behaves exactly like a fresh install and needs no reset tail.
		 * @param field - field name.
		 * @param text - the form's staged text for it.
		 * @returns true when the value carries no visible difference.
		 */
		function atDefault(field, text) {
			const fallback = DEFAULTS[field];
			const trimmed = String(text ?? '').trim();
			if (trimmed === '') return true;
			if (typeof fallback === 'boolean') return trimmed === String(fallback);
			if (typeof fallback === 'number') {
				const parsed = Number(trimmed);
				return Number.isFinite(parsed) && parsed === fallback;
			}
			return trimmed === fallback;
		}

		/** Text controls, in reading order. `hint` rides the label's tooltip. */
		const TEXT_FIELDS = [
			{ field: 'askTitle', label: '提问标题', hint: '助手提问时提醒卡片的标题。' },
			{ field: 'askBody', label: '提问正文', hint: '提问没有附带文字时显示的正文。' },
			{ field: 'approveTitle', label: '审批标题', hint: '有操作等你批准或拒绝时的标题。' },
			{ field: 'approveBody', label: '审批正文', hint: '审批请求没有给出理由时显示的正文。' },
			{ field: 'doneTitle', label: '完成标题', hint: '一轮任务结束时提醒卡片的标题。' },
			{ field: 'doneBody', label: '完成正文', hint: '一轮任务结束时提醒卡片的正文。' },
		];

		/** Number controls, in reading order. */
		const NUMBER_FIELDS = [
			{ field: 'repeatSeconds', label: '重复间隔（秒）', hint: '提问或审批没处理时每隔多久再提醒一次；0 表示只提醒一次。' },
			{ field: 'maxAlerts', label: '最多提醒次数', hint: '含第一次提醒在内的总次数，最小 1。' },
		];

		/** Two-state controls that decide when a card appears. */
		const TIMING_FIELDS = [
			{ field: 'onApproval', label: '审批时提醒', hint: '有操作等你批准或拒绝时弹出卡片。' },
			{ field: 'onDone', label: '完成时提醒', hint: '一轮任务结束、助手转为空闲时弹出卡片。' },
		];

		/** Two-state controls that decide what a card looks and sounds like. */
		const STYLE_FIELDS = [
			{ field: 'showProject', label: '显示项目名', hint: '在提醒正文前加上当前工作目录的名称。' },
			{ field: 'sound', label: '提示音', hint: '弹出卡片时播放系统提示音。' },
		];

		/** Every two-state control, in reading order. */
		const BOOL_FIELDS = [...TIMING_FIELDS, ...STYLE_FIELDS];

		/**
		 * The draft/write conversion of one boolean field: a switch stages the
		 * text the shared form compares against the stored value.
		 * @param field - field name inside the namespace section.
		 * @returns the field's conversion spec.
		 */
		function settingsBooleanField(field) {
			return {
				field,
				format: (value) => (typeof value === 'boolean' ? String(value) : ''),
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === '') return { kind: 'clear' };
					if (trimmed === 'true') return { kind: 'set', value: true };
					if (trimmed === 'false') return { kind: 'set', value: false };
					return undefined;
				},
			};
		}

		/** Width shared by every row label, so the controls line up. */
		const LABEL_WIDTH = '120px';

		const styles = {
			section: { margin: '18px 0 6px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
			sectionFirst: { margin: '6px 0 6px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
			row: { display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0' },
			switchRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 0' },
			label: {
				flex: `0 0 ${LABEL_WIDTH}`,
				width: LABEL_WIDTH,
				fontSize: '13px',
				lineHeight: '1.4',
				color: 'var(--dsw-alias-label-primary)',
				whiteSpace: 'nowrap',
				overflow: 'hidden',
				textOverflow: 'ellipsis',
			},
			input: {
				flex: '1 1 auto',
				minWidth: 0,
				height: '30px',
				padding: '0 10px',
				border: '0.5px solid var(--dsw-alias-border-l4)',
				borderRadius: 'var(--dsw-radius-md)',
				background: 'var(--dsw-alias-bg-layer-3)',
				font: 'inherit',
				fontSize: '13px',
				color: 'var(--dsw-alias-label-primary)',
			},
			inputInvalid: { borderColor: 'var(--dsw-alias-state-error-primary)' },
			message: {
				margin: `2px 0 0 calc(${LABEL_WIDTH} + 10px)`,
				fontSize: '12px',
				lineHeight: '1.4',
				color: 'var(--dsw-alias-state-error-primary)',
			},
			badges: { display: 'inline-flex', alignItems: 'center', gap: '6px', flex: 'none' },
			overridden: { fontSize: '12px', lineHeight: '1.2', color: 'var(--dsw-alias-label-tertiary)', flex: 'none' },
			/**
			 * Sized to stay inside a row's tallest control (the 20px switch): a taller
			 * tail would push its row a few pixels past its neighbours, which reads as
			 * a broken rhythm since only the overridden rows carry one.
			 */
			reset: {
				border: '0.5px solid var(--dsw-alias-border-l4)',
				borderRadius: 'var(--dsw-radius-sm)',
				background: 'var(--dsw-alias-bg-layer-3)',
				padding: '1px 6px',
				font: 'inherit',
				fontSize: '12px',
				lineHeight: '1.2',
				color: 'var(--dsw-alias-label-secondary)',
				cursor: 'pointer',
				flex: 'none',
			},
			status: {
				margin: '16px 0 0',
				fontSize: '12px',
				lineHeight: '1.4',
				color: 'var(--dsw-alias-label-tertiary)',
			},
			statusError: { color: 'var(--dsw-alias-state-error-primary)' },
			notice: { margin: 0, fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-tertiary)' },
		};

		/**
		 * The trailing reset affordance: shown only once the draft would leave an
		 * override behind, exactly like the shared settings controls.
		 * @param props - whether the field is overridden and the reset action.
		 * @returns the badge and reset button, or null.
		 */
		function OverrideTail(props) {
			if (!props.overridden) return null;
			return h(
				'span',
				{ style: styles.badges },
				h('span', { style: styles.overridden }, LABELS.overridden),
				h(
					'button',
					{ type: 'button', style: styles.reset, disabled: props.disabled, onClick: props.onReset },
					LABELS.reset,
				),
			);
		}

		/**
		 * One text or number row: label, input, and the override tail on a single
		 * line. The hint is the label's hover text, so it costs no vertical space.
		 * @param props - the field copy, its staged state, and the edit actions.
		 * @returns the row.
		 */
		function ValueRow(props) {
			const state = props.state;
			const inputStyle = state.invalid
				? Object.assign({}, styles.input, styles.inputInvalid)
				: styles.input;
			return h(
				'div',
				null,
				h(
					'div',
					{ style: styles.row },
					h('label', { style: styles.label, title: props.hint, htmlFor: props.id }, props.label),
					h('input', {
						id: props.id,
						style: inputStyle,
						type: 'text',
						inputMode: props.numeric ? 'numeric' : undefined,
						placeholder: props.placeholder,
						'aria-invalid': state.invalid ? true : undefined,
						value: state.text,
						disabled: props.disabled,
						onChange: (event) => {
							props.onEdit(event.target.value);
						},
						onBlur: () => {
							props.onCommit();
						},
						onKeyDown: (event) => {
							if (event.key !== 'Enter') return;
							event.preventDefault();
							event.currentTarget.blur();
						},
					}),
					h(OverrideTail, {
						overridden: props.overridden,
						disabled: props.disabled,
						onReset: props.onReset,
					}),
				),
				state.invalid
					? h('p', { style: styles.message }, props.numeric ? LABELS.invalidNumber : LABELS.invalidText)
					: null,
			);
		}

		/**
		 * One boolean row: the label on the left, the switch in the same column the
		 * inputs start in, so the switches line up right below the text controls.
		 * @param props - the field copy, its staged state, and the edit actions.
		 * @returns the row.
		 */
		function SwitchRow(props) {
			const state = props.state;
			return h(
				'div',
				{ style: styles.switchRow },
				h('label', { style: styles.label, title: props.hint }, props.label),
				h(primitives.Switch, {
					checked: state.text === 'true',
					label: props.label,
					disabled: props.disabled || state.invalid,
					onChange: (next) => {
						props.onEdit(next ? 'true' : 'false');
					},
				}),
				h(OverrideTail, {
					overridden: props.overridden,
					disabled: props.disabled,
					onReset: props.onReset,
				}),
			);
		}

		/**
		 * Render this plugin's settings form.
		 *
		 * Edits are committed the way desktop settings usually behave: a switch or
		 * the reset control writes immediately, a text or number field writes when
		 * it loses focus (Enter just blurs it), so there is no save button to
		 * remember. Invalid drafts are never written — the row's own message says
		 * why, and leaving the field simply keeps the stored value.
		 *
		 * @param props - the view asked for, the form state, and its actions.
		 * @returns the one-liner, or the form.
		 */
		function AlertCard(props) {
			const state = props.useAlertCard((snapshot) => snapshot);
			const [saved, setSaved] = React.useState(false);
			const wanted = React.useRef(false);

			React.useEffect(() => {
				if (!wanted.current) return;
				if (state.saving) return;
				if (state.invalid) {
					wanted.current = false;
					return;
				}
				if (!state.dirty) {
					wanted.current = false;
					return;
				}
				wanted.current = false;
				const pending = props.save();
				if (pending && typeof pending.then === 'function') pending.then(() => setSaved(true), () => setSaved(false));
				else setSaved(true);
			}, [state]);

			if (props.view === 'summary') return h('p', { style: { margin: 0, fontSize: '12px', opacity: 0.6 } }, LABELS.summary);
			if (!state.available) return h('p', { style: styles.notice }, state.writable === false ? LABELS.readOnly : LABELS.unavailable);
			const disabled = !state.writable;

			/** Ask for a write once the next snapshot reflects the edit just staged. */
			const commit = () => {
				wanted.current = true;
			};

			const edit = (field, text) => {
				setSaved(false);
				props.edit(field, text);
			};

			/** The reset tail, hidden once the value is back at the shipped default. */
			const tail = (field) => {
				const staged = state[field.field];
				return staged.overridden && !atDefault(field.field, staged.text);
			};

			const textRows = TEXT_FIELDS.map((field) =>
				h(ValueRow, {
					key: field.field,
					id: 'dsh-ask-alert-' + field.field,
					label: field.label,
					hint: field.hint,
					state: state[field.field],
					overridden: tail(field),
					disabled,
					onEdit: (text) => {
						edit(field.field, text);
					},
					onCommit: commit,
					onReset: () => {
						props.resetField(field.field);
						commit();
					},
				}),
			);

			const numberRows = NUMBER_FIELDS.map((field) =>
				h(ValueRow, {
					key: field.field,
					id: 'dsh-ask-alert-' + field.field,
					label: field.label,
					hint: field.hint,
					numeric: true,
					state: state[field.field],
					overridden: tail(field),
					disabled,
					onEdit: (text) => {
						edit(field.field, text);
					},
					onCommit: commit,
					onReset: () => {
						props.resetField(field.field);
						commit();
					},
				}),
			);

			const switchRows = (fields) =>
				fields.map((field) =>
					h(SwitchRow, {
						key: field.field,
						label: field.label,
						hint: field.hint,
						state: state[field.field],
						overridden: tail(field),
						disabled,
						onEdit: (text) => {
							edit(field.field, text);
							commit();
						},
						onReset: () => {
							props.resetField(field.field);
							commit();
						},
					}),
				);

			const status = state.saving
				? { text: LABELS.statusSaving, error: false }
				: state.failed
					? { text: LABELS.statusFailed, error: true }
					: state.invalid
						? { text: LABELS.statusInvalid, error: true }
						: saved || !state.dirty
							? { text: LABELS.statusSaved, error: false }
							: null;

			return h(
				'div',
				null,
				h('p', { key: 's1', style: styles.sectionFirst }, '提醒文案'),
				h('div', { key: 'g1' }, textRows),
				h('p', { key: 's2', style: styles.section }, '提醒时机'),
				h('div', { key: 'g2' }, switchRows(TIMING_FIELDS)),
				h('p', { key: 's4', style: styles.section }, '提醒样式'),
				h('div', { key: 'g4' }, switchRows(STYLE_FIELDS)),
				h('p', { key: 's3', style: styles.section }, '重复提醒'),
				h('div', { key: 'g3' }, numberRows),
				status
					? h('p', { key: 'status', style: status.error ? Object.assign({}, styles.status, styles.statusError) : styles.status }, status.text)
					: null,
			);
		}

		/** Required client services. */
		const inject = ['slots', 'configForms'];

		/**
		 * Mount the settings form while the Host serves this plugin's namespace.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const form = new primitives.SettingsFormModel(
				ctx.configForms.get(NS),
				[
					...TEXT_FIELDS.map((item) => primitives.settingsTextField(item.field)),
					...NUMBER_FIELDS.map((item) => primitives.settingsNumberField(item.field)),
					...BOOL_FIELDS.map((item) => settingsBooleanField(item.field)),
				],
			);
			const store = form.bind(() => {
				const projection = { ...form.shell(), title: LABELS.title };
				for (const item of TEXT_FIELDS) projection[item.field] = form.field(item.field);
				for (const item of NUMBER_FIELDS) projection[item.field] = form.field(item.field);
				for (const item of BOOL_FIELDS) projection[item.field] = form.field(item.field);
				return projection;
			});
			ctx.effect(() => () => {
				form.dispose();
			}, 'dsh-ask-alert: form');
			const face = { hooks: { alertCard: store }, ...form.actions() };
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NS], (served) => {
						if (!served.has(NS)) return undefined;
						return ctx.slots.inject('plugins.bundle.config', () =>
							ctx.slots.register(
								{ name: 'plugins.bundle.config', key: NS, inject: () => face },
								AlertCard,
							),
						);
					}),
				'dsh-ask-alert: settings card',
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
