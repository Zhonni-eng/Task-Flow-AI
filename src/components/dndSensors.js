// Drag sensors tuned for task cards:
// - Pointer: the whole card can be dragged after moving a few pixels, so a plain
//   click still opens the task. Controls marked [data-no-dnd] never start a drag.
// - Keyboard: only the dedicated drag handle starts a keyboard drag, so Enter on
//   the card title keeps opening the task.
import { KeyboardSensor, PointerSensor } from '@dnd-kit/core';

const isInside = (event, selector) => event.nativeEvent.target instanceof Element && event.nativeEvent.target.closest(selector);

export class CardPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown',
      handler: (event, options) =>
        isInside(event, '[data-no-dnd]') ? false : PointerSensor.activators[0].handler(event, options),
    },
  ];
}

export class HandleKeyboardSensor extends KeyboardSensor {
  static activators = [
    {
      eventName: 'onKeyDown',
      handler: (event, options, context) =>
        isInside(event, '[data-drag-handle]') ? KeyboardSensor.activators[0].handler(event, options, context) : false,
    },
  ];
}
