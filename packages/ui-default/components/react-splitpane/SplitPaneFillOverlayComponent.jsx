import classNames from 'classnames';
import PropTypes from 'prop-types';

export default function SplitPaneFillOverlayComponent(props) {
  const {
    className,
    children,
    ...rest
  } = props;
  const cn = classNames(className, 'splitpane-fill');
  return (
    <div {...rest} className={cn}>{children}</div>
  );
}

SplitPaneFillOverlayComponent.propTypes = {
  className: PropTypes.string,
  children: PropTypes.node,
};
