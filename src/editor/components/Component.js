class Component {
  constructor(type, parent) {
    this.elem = document.createElement(type);
    (parent || document.body).appendChild(this.elem);
  }
}

export default Component;
