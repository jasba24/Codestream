import _ from "underscore";
import React from "react";
import ContentEditable from "react-contenteditable";
import createClassString from "classnames";
import EventEmitter from "../event-emitter";
import AtMentionsPopup from "./AtMentionsPopup";
import Icon from "./Icon";
import EmojiPicker from "./EmojiPicker";
import { getCurrentCursorPosition, createRange } from "../utils";
const emojiData = require("../node_modules/markdown-it-emoji-mart/lib/data/full.json");

const arrayToRange = ([startRow, startCol, endRow, endCol]) => {
	return {
		start: {
			row: startRow,
			col: startCol
		},
		end: {
			row: endRow,
			col: endCol
		}
	};
};

class ComposeBox extends React.Component {
	state = {
		postTextByStream: {},
		quote: null,
		autoMentions: [],
		popupOpen: false,
		emojiPickerOpen: false
	};
	disposables = [];

	componentDidMount() {
		this.disposables.push(
			EventEmitter.subscribe("interaction:code-highlighted", this.handleCodeHighlightEvent)
		);

		// so that HTML doesn't get pasted into the input field. without this,
		// HTML would be rendered as HTML when pasted
		this._contentEditable.htmlEl.addEventListener("paste", function(e) {
			e.preventDefault();
			const text = e.clipboardData.getData("text/plain");
			document.execCommand("insertHTML", false, text.replace(/\n/g, "<br>"));
		});

		// because atom hijacks most keystroke events
		if (global.atom) {
			this.disposables.push(
				atom.commands.add("atom-workspace", {
					"codestream:focus-input": _event => this.focus()
				}),
				atom.commands.add(".codestream", "codestream:escape", {
					didDispatch: event => this.handleAtMentionKeyPress(event, "escape"),
					hiddenInCommandPalette: true
				}),
				atom.commands.add(".codestream .compose.popup-open", "codestream:popup-move-up", {
					didDispatch: event => this.handleAtMentionKeyPress(event, "up"),
					hiddenInCommandPalette: true
				}),
				atom.commands.add(".codestream .compose.popup-open", "codestream:popup-move-down", {
					didDispatch: event => this.handleAtMentionKeyPress(event, "down"),
					hiddenInCommandPalette: true
				}),
				atom.commands.add(".codestream .compose.popup-open", "codestream:popup-tab", {
					didDispatch: event => this.handleAtMentionKeyPress(event, "tab"),
					hiddenInCommandPalette: true
				}),
				atom.commands.add(".codestream .native-key-bindings", "codestream:move-up", {
					didDispatch: event => this.handleNonCapturedKeyPress(event, "up"),
					hiddenInCommandPalette: true
				})
			);
		}
	}

	componentWillUnmount() {
		this.disposables.forEach(d => d.dispose());
	}

	handleCodeHighlightEvent = body => {
		// make sure we have a compose box to type into
		this.props.ensureStreamIsActive();
		this.setState({ quote: body });

		let mentions = [];
		if (body.source && body.source.authors) {
			mentions = body.source.authors.filter(author => author.id !== this.props.currentUserId);
		}

		if (mentions.length > 0) {
			// TODO handle users with no username
			const usernames = mentions.map(u => `@${u.username}`);
			this.setState({ autoMentions: usernames });
			// the reason for this unicode space is that chrome will
			// not render a space at the end of a contenteditable div
			// unless it is a &nbsp;, which is difficult to insert
			// so we insert this unicode character instead
			const newText = usernames.join(", ") + ":\u00A0";
			this.insertTextAtCursor(newText);
		}
	};

	insertIfEmpty(newText) {
		// if there's text in the compose area, return without
		// adding the suggestion
		if (
			this.state.postTextByStream[this.props.streamId] &&
			this.state.postTextByStream[this.props.streamId].length > 0
		)
			return;
		// the reason for this unicode space is that chrome will
		// not render a space at the end of a contenteditable div
		// unless it is a &nbsp;, which is difficult to insert
		// so we insert this unicode character instead
		this.insertTextAtCursor(newText + ":\u00A0");
	}

	focus = () => {
		this._contentEditable.htmlEl.focus();
	};

	// set up the parameters to pass to the at mention popup
	showPopupSelectors(prefix, type) {
		let itemsToShow = [];

		// console.log("SERVICES: ", this.props.services);

		if (type === "at-mentions") {
			Object.values(this.props.teammates).forEach(person => {
				let toMatch = person.fullName + "*" + person.username;
				if (toMatch.toLowerCase().indexOf(prefix) !== -1) {
					itemsToShow.push({
						id: person.id,
						headshot: person,
						identifier: person.username || person.email,
						description: person.fullName
					});
				}
			});
		} else if (type === "slash-commands") {
			this.props.slashCommands.map(command => {
				if (command.channelOnly && this.props.isDirectMessage) return;
				if (command.requires && !this.props.services[command.requires]) return;
				if (command.codeStreamTeam && this.props.isSlackTeam) return;
				let lowered = command.id.toLowerCase();
				if (lowered.indexOf(prefix) === 0) {
					command.identifier = command.id;
					itemsToShow.push(command);
				}
			});
		} else if (type === "channels") {
			Object.values(this.props.channelStreams).forEach(channel => {
				let toMatch = channel.name;
				if (toMatch.toLowerCase().indexOf(prefix) !== -1) {
					itemsToShow.push({
						id: channel.name,
						identifier: "#" + channel.name,
						description: channel.purpose
					});
				}
			});
		} else if (type === "emojis") {
			if (prefix && prefix.length > 1) {
				Object.keys(emojiData).map(emojiId => {
					if (emojiId.indexOf(prefix) === 0) {
						itemsToShow.push({ id: emojiId, identifier: emojiData[emojiId] + " " + emojiId });
					}
				});
			} else {
				itemsToShow.push({
					description: "Matching Emoji. Type 2 or more characters"
				});
			}
		}

		if (itemsToShow.length == 0) {
			this.hidePopup();
		} else {
			let selected = itemsToShow[0].id;

			this.setState({
				popupOpen: type,
				popupPrefix: prefix,
				popupItems: itemsToShow,
				popupIndex: 0,
				selectedPopupItem: selected
			});
		}
	}

	hidePopup() {
		this.setState({ popupOpen: false });
	}

	selectFirst() {
		this.handleSelectAtMention();
	}

	// insert the given text at the cursor of the input field
	// after first deleting the text in toDelete
	insertTextAtCursor(text, toDelete) {
		var sel, range;
		sel = window.getSelection();

		// if for some crazy reason we can't find a selection, return
		// to avoid an error.
		// https://stackoverflow.com/questions/22935320/uncaught-indexsizeerror-failed-to-execute-getrangeat-on-selection-0-is-not
		if (sel.rangeCount == 0) return;

		range = sel.getRangeAt(0);

		// delete the X characters before the caret
		range.setStart(range.commonAncestorContainer, range.startOffset - (toDelete || "").length);
		// range.moveEnd("character", toDelete.length);

		range.deleteContents();
		var textNode = document.createTextNode(text);
		range.insertNode(textNode);
		range.setStartAfter(textNode);
		sel.removeAllRanges();
		sel.addRange(range);
		this._contentEditable.htmlEl.normalize();
		// sel.collapse(textNode);
		sel.modify("move", "backward", "character");
		sel.modify("move", "forward", "character");
		// window.getSelection().empty();
		// this.focus();

		let postTextByStream = this.state.postTextByStream;
		postTextByStream[this.props.streamId] = this._contentEditable.htmlEl.innerHTML;

		this.setState({
			postTextByStream,
			cursorPosition: getCurrentCursorPosition("input-div")
		});
	}

	// the keypress handler for tracking up and down arrow
	// and enter, while the at mention popup is open
	handleAtMentionKeyPress(event, eventType) {
		event.preventDefault();
		if (eventType == "escape") {
			if (this.state.popupOpen) this.hidePopup();
			if (this.state.emojiPickerOpen) this.hideEmojiPicker();
			// else this.handleDismissThread();
		} else {
			let newIndex = 0;
			if (eventType == "down") {
				if (this.state.popupIndex < this.state.popupItems.length - 1) {
					newIndex = this.state.popupIndex + 1;
				} else {
					newIndex = 0;
				}
			} else if (eventType == "up") {
				if (this.state.popupIndex == 0) {
					newIndex = this.state.popupItems.length - 1;
				} else {
					newIndex = this.state.popupIndex - 1;
				}
			} else if (eventType == "tab") {
				this.selectFirst();
			}
			this.setState({
				popupIndex: newIndex,
				selectedPopupItem: this.state.popupItems[newIndex].id
			});
		}
	}

	// for keypresses that we can't capture with standard
	// javascript events
	handleNonCapturedKeyPress(event, eventType) {
		if (eventType == "up") {
			if (this.state.postTextByStream[this.props.streamId] === "") {
				this.props.onEmptyUpArrow(event);
			}
		}
		event.abortKeyBinding();
	}

	// when the user hovers over an at-mention list item, change the
	// state to represent a hovered state
	handleHoverAtMention = id => {
		let index = this.state.popupItems.findIndex(x => x.id == id);

		this.setState({
			popupIndex: index,
			selectedPopupItem: id
		});
	};

	handleSelectAtMention = id => {
		// if no id is passed, we assume that we're selecting
		// the currently-selected at mention
		if (!id) id = this.state.selectedPopupItem;

		let toInsert;
		let toInsertPostfix = "";

		if (this.state.popupOpen === "slash-commands") {
			toInsert = id + "\u00A0";
		} else if (this.state.popupOpen === "channels") {
			toInsert = id + "\u00A0";
		} else if (this.state.popupOpen === "emojis") {
			toInsert = id + ":\u00A0";
		} else {
			let user = this.props.teammates.find(t => t.id === id);
			if (!user) return;
			toInsert = user.username + "\u00A0";
		}
		this.hidePopup();
		setTimeout(() => {
			this.focus();
		}, 20);
		// the reason for this unicode space is that chrome will
		// not render a space at the end of a contenteditable div
		// unless it is a &nbsp;, which is difficult to insert
		// so we insert this unicode character instead
		this.insertTextAtCursor(toInsert, this.state.popupPrefix);
		// this.setNewPostText(text);
	};

	// depending on the contents of the input field, if the user
	// types a "@" then open the at-mention popup
	handleChange = event => {
		const newPostText = event.target.value;

		const selection = window.getSelection();
		const range = selection.getRangeAt(0);
		const node = range.commonAncestorContainer;
		const nodeText = node.textContent || "";
		const upToCursor = nodeText.substring(0, range.startOffset);
		const peopleMatch = upToCursor.match(/(?:^|\s)@([a-zA-Z0-9_.+]*)$/);
		const channelMatch = upToCursor.match(/(?:^|\s)#([a-zA-Z0-9_.+]*)$/);
		const emojiMatch = upToCursor.match(/(?:^|\s):([a-z+_]*)$/);
		const slashMatch = newPostText.match(/^\/([a-zA-Z0-9+]*)$/);
		if (this.state.popupOpen === "at-mentions") {
			if (peopleMatch) {
				this.showPopupSelectors(peopleMatch[1].replace(/@/, ""), "at-mentions");
			} else {
				// if the line doesn't end with @word, then hide the popup
				this.hidePopup();
			}
		} else if (this.state.popupOpen === "slash-commands") {
			if (slashMatch) {
				this.showPopupSelectors(slashMatch[0].replace(/\//, ""), "slash-commands");
			} else {
				// if the line doesn't start with /word, then hide the popup
				this.hidePopup();
			}
		} else if (this.state.popupOpen === "channels") {
			if (channelMatch) {
				this.showPopupSelectors(channelMatch[1].replace(/#/, ""), "channels");
			} else {
				// if the line doesn't end with #word, then hide the popup
				this.hidePopup();
			}
		} else if (this.state.popupOpen === "emojis") {
			if (emojiMatch) {
				this.showPopupSelectors(emojiMatch[1].replace(/:/, ""), "emojis");
			} else {
				// if the line doesn't look like :word, then hide the popup
				this.hidePopup();
			}
		} else {
			if (peopleMatch) this.showPopupSelectors(peopleMatch[1].replace(/@/, ""), "at-mentions");
			if (slashMatch) this.showPopupSelectors(slashMatch[0].replace(/\//, ""), "slash-commands");
			if (channelMatch) this.showPopupSelectors(channelMatch[1].replace(/#/, ""), "channels");
			if (emojiMatch) this.showPopupSelectors(emojiMatch[1].replace(/:/, ""), "emojis");
		}
		// track newPostText as the user types
		let postTextByStream = this.state.postTextByStream;
		postTextByStream[this.props.streamId] = this._contentEditable.htmlEl.innerHTML;
		// this.setState({ postTextByStream });
		this.setState({
			postTextByStream,
			autoMentions: this.state.autoMentions.filter(mention => newPostText.includes(mention)),
			cursorPosition: getCurrentCursorPosition("input-div")
		});
	};

	// when the input field loses focus, one thing we want to do is
	// to hide the at-mention popup
	handleBlur = event => {
		event.preventDefault();
		this.hidePopup();
	};

	handleClick = event => {
		this.setState({
			cursorPosition: getCurrentCursorPosition("input-div")
		});
	};

	// https://stackoverflow.com/questions/6249095/how-to-set-caretcursor-position-in-contenteditable-element-div
	setCurrentCursorPosition = chars => {
		if (this._contentEditable.htmlEl.innerHTML === "") {
			return;
		}
		if (chars < 0) chars = 0;

		var selection = window.getSelection();

		let range = createRange(document.getElementById("input-div").parentNode, { count: chars });

		if (range) {
			range.collapse(false);
			selection.removeAllRanges();
			selection.addRange(range);
		}
	};

	handleKeyPress = event => {
		let newPostText = this.state.postTextByStream[this.props.streamId] || "";

		// if we have the at-mentions popup open, then the keys
		// do something different than if we have the focus in
		// the textarea
		if (this.state.popupOpen) {
			if (event.key == "Escape") {
				this.hidePopup();
			} else if (event.key == "Enter" && !event.shiftKey) {
				event.preventDefault();
				this.selectFirst();
			}
		} else if (event.key === "@") {
			this.showPopupSelectors("", "at-mentions");
		} else if (event.key === ":") {
			this.showPopupSelectors("", "emojis");
		} else if (event.key === "/" && newPostText.length === 0) {
			this.showPopupSelectors("", "slash-commands");
		} else if (event.key === "#") {
			this.showPopupSelectors("", "channels");
		} else if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			if (newPostText.trim().length > 0 && !this.props.disabled) {
				// convert the text to plaintext so there is no HTML
				let text = newPostText.replace(/<br>/g, "\n");
				const doc = new DOMParser().parseFromString(text, "text/html");
				text = doc.documentElement.textContent;

				this.props.onSubmit({
					text,
					quote: this.state.quote,
					mentionedUserIds: this.props.findMentionedUserIds(text, this.props.teammates),
					autoMentions: this.state.autoMentions
				});
				this.reset();
			} else {
				// don't submit blank posts
			}
		}
	};

	handleKeyDown = event => {
		if (this.state.popupOpen) {
			if (event.key === "ArrowUp") {
				event.stopPropagation();
				this.handleAtMentionKeyPress(event, "up");
			}
			if (event.key === "ArrowDown") this.handleAtMentionKeyPress(event, "down");
			if (event.key === "Tab") this.handleAtMentionKeyPress(event, "tab");
			if (event.key === "Escape") {
				this.hidePopup();
				event.preventDefault();
			}
		} else if (this.state.emojiPickerOpen) {
			if (event.key === "Escape") {
				this.hideEmojiPicker();
				event.preventDefault();
			}
		} else {
			if (event.key === "ArrowUp" && this.state.postTextByStream[this.props.streamId] === "") {
				event.persist();
				event.stopPropagation();
				this.props.onEmptyUpArrow(event);
			}
		}
	};

	handleClickDismissQuote = event => {
		event.preventDefault();
		this.focus();
		this.reset();
	};

	toggleEmojiPicker = event => {
		this.setState({ emojiPickerOpen: !this.state.emojiPickerOpen });
		// this.focus();
		// event.stopPropagation();
	};

	hideEmojiPicker = () => {
		this.setState({ emojiPickerOpen: false });
	};

	addEmoji = emoji => {
		this.setState({ emojiPickerOpen: false });
		if (emoji && emoji.colons) {
			this.focus();
			this.setCurrentCursorPosition(this.state.cursorPosition);
			this.insertTextAtCursor(emoji.colons); // + "\u00A0"); <= that's a space
		}
	};

	reset() {
		this.setState({ postTextByStream: [], quote: null, autoMentions: [], emojiPickerOpen: false });
	}

	render() {
		const { forwardedRef, placeholder } = this.props;
		const { quote, emojiPickerOpen } = this.state;

		let quoteInfo;
		let quoteHint;
		if (quote) {
			quoteInfo = quote ? <div className="code">{quote.code}</div> : "";
			let range = arrayToRange(quote.location);
			let rangeText = null;
			if (range) {
				if (range.start.row === range.end.row) {
					rangeText = "Commenting on line " + (range.start.row + 1);
				} else {
					rangeText = "Commenting on lines " + (range.start.row + 1) + "-" + (range.end.row + 1);
				}
			}
			quoteHint = (
				<div className="hint">
					{rangeText}
					<Icon name="x" onClick={this.handleClickDismissQuote} />
				</div>
			);
		}

		let contentEditableHTML = this.state.postTextByStream[this.props.streamId] || "";

		return (
			<div
				ref={forwardedRef}
				onKeyPress={this.handleKeyPress}
				onKeyDown={this.handleKeyDown}
				className={createClassString("compose", {
					offscreen: this.props.offscreen,
					"popup-open": this.state.popupOpen
				})}
			>
				<AtMentionsPopup
					on={this.state.popupOpen}
					items={this.state.popupItems}
					prefix={this.state.popupPrefix}
					selected={this.state.selectedPopupItem}
					handleHoverAtMention={this.handleHoverAtMention}
					handleSelectAtMention={this.handleSelectAtMention}
				/>
				{quoteInfo}
				{quoteHint}
				<Icon
					name="smiley"
					className={createClassString("smiley", {
						hover: emojiPickerOpen
					})}
					onClick={this.toggleEmojiPicker}
				/>
				{emojiPickerOpen && (
					<EmojiPicker
						addEmoji={this.addEmoji}
						autoFocus={true}
						style={{
							position: "absolute",
							bottom: "45px",
							right: "10px"
						}}
					/>
				)}
				<ContentEditable
					className={createClassString("native-key-bindings", "message-input", btoa(placeholder))}
					id="input-div"
					rows="1"
					tabIndex="-1"
					onChange={this.handleChange}
					onBlur={this.handleBlur}
					onClick={this.handleClick}
					html={contentEditableHTML}
					placeholder={placeholder}
					ref={ref => (this._contentEditable = ref)}
				/>
			</div>
		);
	}
}

export default React.forwardRef((props, ref) => <ComposeBox {...props} forwardedRef={ref} />);
