import { store } from '../store/store';
import { Modal } from './Dialogs';
export default function DeliverDialog() {
  return <Modal title="交付" onClose={() => store.actions.setState('dialog', '')}>TODO</Modal>;
}
